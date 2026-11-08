import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePng, startMock, type MockChatGPT } from "./mock/server.js";

const CHROME = process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath();
const PORT = 18000 + Math.floor(Math.random() * 1000);

let mock: MockChatGPT;
let proc: ChildProcess;
let client: Client;
let dataDir: string;
let logs = "";

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string; uri?: string }>;
const json = (r: { content: unknown }) => JSON.parse(((r.content as Content)[0].text) ?? "{}");

async function waitHealthy(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${logs}`);
}

beforeAll(async () => {
  mock = await startMock();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-e2e-"));
  proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      CHATGPT_BASE_URL: mock.url,
      ALLOW_CUSTOM_BASE_URL: "true",
      CHATGPT_SESSION_TOKEN: mock.token,
      HEADLESS: "true",
      BROWSER_EXECUTABLE_PATH: CHROME,
      MCP_AUTH_TOKEN: "secret-token",
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
      LOG_LEVEL: "debug",
      READY_TIMEOUT_SECONDS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (d) => (logs += d));
  await waitHealthy(`http://127.0.0.1:${PORT}/healthz`);
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: "Bearer secret-token" } } }),
  );
});

afterAll(async () => {
  await client?.close().catch(() => {});
  proc?.kill("SIGTERM");
  await mock?.close();
  if (process.env.KEEP_LOGS) console.log(logs);
});

describe("e2e against mock ChatGPT", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("lists tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["generate_image", "edit_image", "refine_image", "create_variations", "get_job", "list_images", "save_profile", "check_session"]) {
      expect(names).toContain(n);
    }
  });

  it("reports a ready session", async () => {
    const r = await client.callTool({ name: "check_session", arguments: {} });
    expect(json(r).state).toBe("ready");
  });

  let firstImage = "";
  let conversation = "";

  it("generates an image and returns it inline + as a link", async () => {
    const r = await client.callTool({ name: "generate_image", arguments: { prompt: "a red bicycle", aspect_ratio: "16:9", style_preset: "photorealistic" } });
    const body = json(r);
    expect(body.status, logs.slice(-3000)).toBe("succeeded");
    const content = r.content as Content;
    expect(content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    expect(content.some((c) => c.type === "resource_link")).toBe(true);
    const img = body.result.images[0];
    expect(img.width).toBe(640);
    firstImage = img.image_id;
    conversation = body.result.conversation_id;
    expect(conversation).toMatch(/[0-9a-f-]{36}/);
    const sent = mock.stats.messages.at(-1)!.text;
    expect(sent).toContain("a red bicycle");
    expect(sent).toContain("16:9");
    expect(sent).toContain("Photorealistic");
    // signed download link works, tampered one does not
    const dl = await fetch(img.download_url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("image/png");
    expect((await fetch(img.download_url.replace(/sig=[^&]+/, "sig=bad"))).status).toBe(403);
  });

  it("refines inside the same conversation", async () => {
    const r = await client.callTool({ name: "refine_image", arguments: { image_id: firstImage, instruction: "make it blue" } });
    const body = json(r);
    expect(body.status, logs.slice(-3000)).toBe("succeeded");
    expect(body.result.conversation_id).toBe(conversation);
    expect(body.result.images[0].parent_image_id).toBe(firstImage);
    expect(mock.stats.messages.at(-1)!.conversation).toBe(conversation);
  });

  it("edits an uploaded image (data URI)", async () => {
    const png = makePng(300, 300, [0, 128, 255]).toString("base64");
    const r = await client.callTool({ name: "edit_image", arguments: { images: [`data:image/png;base64,${png}`], instruction: "add a hat" } });
    expect(json(r).status, logs.slice(-3000)).toBe("succeeded");
    expect(mock.stats.messages.at(-1)!.uploads).toBe(1);
  });

  it("creates multiple variations", async () => {
    const r = await client.callTool({ name: "create_variations", arguments: { image_id: firstImage, count: 2 } });
    const body = json(r);
    expect(body.status, logs.slice(-3000)).toBe("succeeded");
    expect(body.result.images).toHaveLength(2);
  });

  it("maps refusals and usage limits to clear errors", async () => {
    const refused = await client.callTool({ name: "generate_image", arguments: { prompt: "REFUSE this", raw_prompt: true } });
    expect(refused.isError).toBe(true);
    expect(json(refused).error.code).toBe("CONTENT_REFUSED");
    const limited = await client.callTool({ name: "generate_image", arguments: { prompt: "LIMIT", raw_prompt: true } });
    expect(json(limited).error.code).toBe("RATE_LIMITED");
  });

  it("reports text-only answers as NO_IMAGE_RETURNED with the conversation", async () => {
    const r = await client.callTool({ name: "generate_image", arguments: { prompt: "QUESTION car", raw_prompt: true } });
    const body = json(r);
    expect(body.error.code).toBe("NO_IMAGE_RETURNED");
    expect(body.error.message).toContain("what colour");
  }, 60_000);

  it("supports async jobs", async () => {
    const r = await client.callTool({ name: "generate_image", arguments: { prompt: "a cat", wait: false } });
    const { job_id, status } = json(r);
    expect(["queued", "running"]).toContain(status);
    const done = await client.callTool({ name: "get_job", arguments: { job_id, wait_seconds: 60 } });
    expect(json(done).status).toBe("succeeded");
  });

  it("applies saved profiles", async () => {
    await client.callTool({ name: "save_profile", arguments: { name: "Mira", kind: "character", description: "a woman with short silver hair", make_default: true } });
    const r = await client.callTool({ name: "generate_image", arguments: { prompt: "at the beach" } });
    expect(json(r).status).toBe("succeeded");
    expect(mock.stats.messages.at(-1)!.text).toContain("short silver hair");
    const lib = json(await client.callTool({ name: "list_images", arguments: { query: "beach" } }));
    expect(lib.images.length).toBe(1);
  });

  it("serves images as MCP resources", async () => {
    const res = await client.readResource({ uri: `image://${firstImage}` });
    expect(res.contents[0].mimeType).toBe("image/png");
  });
});

describe("login wall", () => {
  it("detects a missing/expired session", async () => {
    const port = PORT + 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-login-"));
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dir, CHATGPT_BASE_URL: mock.url, ALLOW_CUSTOM_BASE_URL: "true", CHATGPT_SESSION_TOKEN: "wrong", HEADLESS: "true", BROWSER_EXECUTABLE_PATH: CHROME, READY_TIMEOUT_SECONDS: "10" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await waitHealthy(`http://127.0.0.1:${port}/healthz`);
      const c = new Client({ name: "e2e-login", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const status = await c.callTool({ name: "check_session", arguments: {} });
      expect(json(status).state).toBe("login_required");
      const gen = await c.callTool({ name: "generate_image", arguments: { prompt: "x" } });
      expect(json(gen).error.code).toBe("LOGIN_REQUIRED");
      await c.close();
    } finally {
      p.kill("SIGTERM");
    }
  });
});
