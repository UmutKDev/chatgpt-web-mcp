import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface StorageCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

const SESSION_COOKIE = "__Secure-next-auth.session-token";

function isStorageState(v: unknown): v is StorageState {
  return !!v && typeof v === "object" && Array.isArray((v as StorageState).cookies);
}

/**
 * Accepts the CHATGPT_SESSION_STATE value in any of these forms:
 *  - Playwright storageState JSON
 *  - the same JSON, base64-encoded (easier to paste into a secret field)
 *  - a path to a file containing either of the above (e.g. an Obot secret file binding)
 *  - a JSON array of cookies exported by a browser extension (EditThisCookie / Cookie-Editor)
 */
export function parseSessionState(raw: string): StorageState {
  let text = raw.trim();
  if (!text) throw new Error("empty session state");
  if (!text.startsWith("{") && !text.startsWith("[") && text.length < 4096 && fs.existsSync(text)) {
    text = fs.readFileSync(text, "utf8").trim();
  }
  if (!text.startsWith("{") && !text.startsWith("[")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8").trim();
    } catch {
      /* fall through */
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("CHATGPT_SESSION_STATE is not JSON, base64 JSON, or a readable file path");
  }
  if (Array.isArray(parsed)) {
    return { cookies: parsed.map(normalizeExtensionCookie).filter(Boolean) as StorageCookie[], origins: [] };
  }
  if (!isStorageState(parsed)) throw new Error("CHATGPT_SESSION_STATE has no cookies array");
  return { cookies: parsed.cookies, origins: parsed.origins ?? [] };
}

function normalizeExtensionCookie(c: Record<string, unknown>): StorageCookie | null {
  if (typeof c?.name !== "string" || typeof c?.value !== "string") return null;
  const same = String(c.sameSite ?? "lax").toLowerCase();
  return {
    name: c.name,
    value: c.value,
    domain: typeof c.domain === "string" ? c.domain : ".chatgpt.com",
    path: typeof c.path === "string" ? c.path : "/",
    expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : typeof c.expires === "number" ? c.expires : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: c.secure === undefined ? true : Boolean(c.secure),
    sameSite: same.startsWith("strict") ? "Strict" : same.startsWith("no") ? "None" : "Lax",
  };
}

/**
 * Builds cookies from CHATGPT_SESSION_TOKEN. Accepts the bare session-token value, the
 * value split in chunks (".0"/".1" cookies joined with "|"), or a whole Cookie header
 * ("name=value; name2=value2").
 */
export function cookiesFromToken(raw: string, baseUrl: string): StorageCookie[] {
  const value = raw.trim();
  const url = new URL(baseUrl);
  const custom = !/(^|\.)chatgpt\.com$/i.test(url.hostname);
  const base = (name: string, v: string): StorageCookie =>
    custom
      ? { name, value: v, domain: url.hostname, path: "/", httpOnly: true, secure: name.startsWith("__Secure-"), sameSite: "Lax", expires: -1 }
      : { name, value: v, domain: ".chatgpt.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires: -1 };

  if (/^[\w.-]+=/.test(value) && !value.startsWith("eyJ")) {
    return value
      .split(/;\s*/)
      .map((pair) => {
        const i = pair.indexOf("=");
        return i > 0 ? base(pair.slice(0, i).trim(), pair.slice(i + 1).trim()) : null;
      })
      .filter((c): c is StorageCookie => !!c && !!c.name);
  }
  if (value.includes("|")) {
    return value.split("|").map((chunk, i) => base(`${SESSION_COOKIE}.${i}`, chunk.trim()));
  }
  return [base(SESSION_COOKIE, value)];
}

export function fingerprint(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

interface PersistedFile {
  sourceFingerprint: string;
  savedAt: string;
  state: StorageState;
}

export class SessionStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "session", "storage-state.json");
  }

  load(sourceFingerprint: string): StorageState | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedFile;
      // If the operator changed the configured secret, the new secret wins.
      if (data.sourceFingerprint !== sourceFingerprint) return null;
      return isStorageState(data.state) ? data.state : null;
    } catch {
      return null;
    }
  }

  save(sourceFingerprint: string, state: StorageState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const body: PersistedFile = { sourceFingerprint, savedAt: new Date().toISOString(), state };
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
