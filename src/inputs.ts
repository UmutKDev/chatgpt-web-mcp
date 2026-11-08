import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { sniffMime } from "./browser/chatgpt-page.js";
import type { AppConfig } from "./config.js";
import { UserFacingError } from "./errors.js";
import type { ImageStore } from "./storage.js";

export interface ResolvedInput {
  file: string;
  mimeType: string;
  bytes: number;
  origin: "library" | "data" | "url" | "path";
  libraryId?: string;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

async function fetchUrl(url: string, maxBytes: number): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UserFacingError("Only http(s) image URLs are supported.", "INVALID_INPUT");
  if (u.username || u.password) throw new UserFacingError("Image URLs must not contain credentials.", "INVALID_INPUT");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new UserFacingError(`Refusing to fetch ${u.hostname}: it resolves to a private or unknown address.`, "INVALID_INPUT");
  }
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new UserFacingError(`Downloading the image failed with HTTP ${res.status}.`, "INVALID_INPUT");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new UserFacingError(`The image at ${u.hostname} is larger than ${maxBytes} bytes.`, "INVALID_INPUT");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function insideAllowed(file: string, allowed: string[]): boolean {
  const real = fs.realpathSync(file);
  return allowed.some((dir) => {
    const rel = path.relative(fs.existsSync(dir) ? fs.realpathSync(dir) : dir, real);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/**
 * Turns caller-supplied image references into local files that Playwright can upload.
 * Accepted: library image id (img_…), data: URI, raw base64, http(s) URL, or a local
 * path inside ALLOWED_INPUT_DIRS.
 */
export async function resolveInputs(refs: string[], cfg: AppConfig, store: ImageStore, workDir: string): Promise<ResolvedInput[]> {
  if (refs.length > cfg.maxInputImages) {
    throw new UserFacingError(`At most ${cfg.maxInputImages} input images are allowed per request.`, "INVALID_INPUT");
  }
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const out: ResolvedInput[] = [];
  for (const [index, rawRef] of refs.entries()) {
    const ref = rawRef.trim();
    let data: Buffer;
    let origin: ResolvedInput["origin"];
    let libraryId: string | undefined;

    if (/^img_[a-z0-9]+$/i.test(ref)) {
      const rec = store.get(ref);
      if (!rec) throw new UserFacingError(`Image ${ref} is not in the library.`, "NOT_FOUND");
      out.push({ file: rec.file, mimeType: rec.mimeType, bytes: rec.bytes, origin: "library", libraryId: rec.id });
      continue;
    } else if (ref.startsWith("data:")) {
      const m = /^data:([\w/+.-]+)?(;base64)?,(.*)$/s.exec(ref);
      if (!m || !m[2]) throw new UserFacingError("Only base64 data: URIs are supported.", "INVALID_INPUT");
      data = Buffer.from(m[3], "base64");
      origin = "data";
    } else if (/^https?:\/\//i.test(ref)) {
      if (!cfg.allowUrlInputs) throw new UserFacingError("URL inputs are disabled on this server (ALLOW_URL_INPUTS=false).", "INVALID_INPUT");
      data = await fetchUrl(ref, cfg.maxInputImageBytes);
      origin = "url";
    } else if (path.isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("~")) {
      if (!cfg.allowedInputDirs.length) {
        throw new UserFacingError("Local file inputs are disabled. Set ALLOWED_INPUT_DIRS, or pass the image as a data: URI or URL.", "INVALID_INPUT");
      }
      const file = path.resolve(ref.replace(/^~/, process.env.HOME ?? "~"));
      if (!fs.existsSync(file) || !insideAllowed(file, cfg.allowedInputDirs)) {
        throw new UserFacingError(`${ref} is not inside ALLOWED_INPUT_DIRS.`, "INVALID_INPUT");
      }
      data = fs.readFileSync(file);
      origin = "path";
    } else if (/^[A-Za-z0-9+/=\s]{200,}$/.test(ref)) {
      data = Buffer.from(ref.replace(/\s+/g, ""), "base64");
      origin = "data";
    } else {
      throw new UserFacingError(`Unrecognised image reference #${index + 1}. Use an image id, data: URI, https URL, or base64.`, "INVALID_INPUT");
    }

    if (data.length > cfg.maxInputImageBytes) throw new UserFacingError(`Input image #${index + 1} exceeds ${cfg.maxInputImageBytes} bytes.`, "INVALID_INPUT");
    const mimeType = sniffMime(data);
    if (!mimeType || mimeType === "image/gif") {
      throw new UserFacingError(`Input image #${index + 1} is not a PNG, JPEG or WebP file.`, "INVALID_INPUT");
    }
    const file = path.join(workDir, `input-${index + 1}.${EXT[mimeType]}`);
    fs.writeFileSync(file, data, { mode: 0o600 });
    out.push({ file, mimeType, bytes: data.length, origin, libraryId });
  }
  return out;
}
