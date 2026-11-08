import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { conversationIdFromUrl, sniffMime } from "../src/browser/chatgpt-page.js";
import { loadSelectors, DEFAULT_SELECTORS } from "../src/browser/selectors.js";
import { cookiesFromToken, parseSessionState } from "../src/browser/session-state.js";
import { loadConfig } from "../src/config.js";
import { FileSigner } from "../src/files.js";
import { resolveInputs } from "../src/inputs.js";
import { JobQueue } from "../src/jobs.js";
import { buildPrompt } from "../src/prompt-builder.js";
import { ImageStore } from "../src/storage.js";
import { makePng } from "./mock/server.js";

describe("session state", () => {
  const state = { cookies: [{ name: "a", value: "b", domain: ".chatgpt.com", path: "/" }], origins: [] };
  it("parses JSON, base64 and files", () => {
    expect(parseSessionState(JSON.stringify(state)).cookies[0].name).toBe("a");
    expect(parseSessionState(Buffer.from(JSON.stringify(state)).toString("base64")).cookies).toHaveLength(1);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-")), "s.json");
    fs.writeFileSync(f, JSON.stringify(state));
    expect(parseSessionState(f).cookies).toHaveLength(1);
  });
  it("parses cookie-extension arrays", () => {
    const s = parseSessionState(JSON.stringify([{ name: "x", value: "y", domain: ".chatgpt.com", sameSite: "no_restriction", expirationDate: 2e9 }]));
    expect(s.cookies[0]).toMatchObject({ name: "x", sameSite: "None", expires: 2000000000 });
  });
  it("rejects garbage", () => {
    expect(() => parseSessionState("not json")).toThrow();
  });
  it("builds cookies from a token, chunks and a cookie header", () => {
    expect(cookiesFromToken("eyJhbGciOi.abc", "https://chatgpt.com")[0]).toMatchObject({ name: "__Secure-next-auth.session-token", domain: ".chatgpt.com", secure: true });
    expect(cookiesFromToken("part0|part1", "https://chatgpt.com").map((c) => c.name)).toEqual([
      "__Secure-next-auth.session-token.0",
      "__Secure-next-auth.session-token.1",
    ]);
    expect(cookiesFromToken("a=1; cf_clearance=2", "https://chatgpt.com").map((c) => c.name)).toEqual(["a", "cf_clearance"]);
  });
});

describe("prompt builder", () => {
  it("wraps generation prompts with the requested specs", () => {
    const p = buildPrompt({ prompt: "a fox", mode: "generate", aspectRatio: "9:16", textInImage: "HELLO", negative: "blur" });
    expect(p).toMatch(/^Create an image/);
    expect(p).toContain("Description: a fox");
    expect(p).toContain("9:16");
    expect(p).toContain('"HELLO"');
    expect(p).toContain("Avoid: blur");
  });
  it("passes raw prompts through", () => {
    expect(buildPrompt({ prompt: " x ", mode: "generate", raw: true })).toBe("x");
  });
});

describe("selectors", () => {
  it("merges overrides", () => {
    const s = loadSelectors(JSON.stringify({ composer: ["#x"], bogus: ["y"] }));
    expect(s.composer).toEqual(["#x"]);
    expect(s.send).toEqual(DEFAULT_SELECTORS.send);
  });
});

describe("helpers", () => {
  it("extracts conversation ids and sniffs mime types", () => {
    expect(conversationIdFromUrl("https://chatgpt.com/c/6720a1b2-0000-4000-8000-123456789abc")).toBe("6720a1b2-0000-4000-8000-123456789abc");
    expect(conversationIdFromUrl("https://chatgpt.com/")).toBeNull();
    expect(sniffMime(makePng(2, 2, [0, 0, 0]))).toBe("image/png");
    expect(sniffMime(Buffer.from("hello world!!"))).toBeNull();
  });
  it("signs and verifies file links", () => {
    const s = new FileSigner("k");
    const { exp, sig } = s.sign("img_1");
    expect(s.verify("img_1", exp, sig)).toBe(true);
    expect(s.verify("img_2", exp, sig)).toBe(false);
    expect(s.verify("img_1", 1, sig)).toBe(false);
  });
});

describe("inputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-"));
  const cfg = { ...loadConfig([]), maxInputImages: 3, allowedInputDirs: [] as string[] };
  const store = new ImageStore(path.join(dir, "out"), 0, 0);
  it("accepts data URIs and rejects non-images", async () => {
    const png = makePng(4, 4, [1, 2, 3]).toString("base64");
    const r = await resolveInputs([`data:image/png;base64,${png}`], cfg, store, path.join(dir, "w"));
    expect(r[0].mimeType).toBe("image/png");
    await expect(resolveInputs([`data:image/png;base64,${Buffer.from("nope nope nope").toString("base64")}`], cfg, store, path.join(dir, "w2"))).rejects.toThrow(/not a PNG/);
  });
  it("blocks local paths unless allowed and private URLs", async () => {
    await expect(resolveInputs(["/etc/passwd"], cfg, store, path.join(dir, "w3"))).rejects.toThrow(/disabled/);
    await expect(resolveInputs(["http://127.0.0.1/x.png"], cfg, store, path.join(dir, "w4"))).rejects.toThrow(/private/);
    await expect(resolveInputs(["a", "b", "c", "d"], cfg, store, path.join(dir, "w5"))).rejects.toThrow(/At most/);
  });
  it("allows files inside ALLOWED_INPUT_DIRS only", async () => {
    const allowed = path.join(dir, "allowed");
    fs.mkdirSync(allowed);
    fs.writeFileSync(path.join(allowed, "a.png"), makePng(4, 4, [1, 1, 1]));
    const c2 = { ...cfg, allowedInputDirs: [allowed] };
    expect((await resolveInputs([path.join(allowed, "a.png")], c2, store, path.join(dir, "w6")))[0].origin).toBe("path");
    await expect(resolveInputs([path.join(allowed, "../out/library.json")], c2, store, path.join(dir, "w7"))).rejects.toThrow();
  });
});

describe("job queue", () => {
  it("runs jobs serially and supports cancel", async () => {
    const q = new JobQueue<number>(1, 5);
    const order: number[] = [];
    const a = q.submit("t", "a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 1;
    });
    const b = q.submit("t", "b", async () => (order.push(2), 2));
    const c = q.submit("t", "c", async () => 3);
    q.cancel(c.id);
    await q.wait(b.id, 2000);
    expect(order).toEqual([1, 2]);
    expect(q.get(a.id)?.status).toBe("succeeded");
    expect(q.get(c.id)?.status).toBe("cancelled");
  });
  it("enforces the queue limit", () => {
    const q = new JobQueue<number>(1, 1);
    q.submit("t", "1", () => new Promise(() => {}));
    q.submit("t", "2", async () => 1);
    expect(() => q.submit("t", "3", async () => 1)).toThrow(/queue is full/);
  });
});
