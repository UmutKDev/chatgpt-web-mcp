/**
 * Log in to ChatGPT on your own computer and print the session for the server.
 *
 *   npm run export-session              # uses your installed Google Chrome
 *   BROWSER_CHANNEL=msedge npm run export-session
 *   BROWSER_EXECUTABLE_PATH=/path/to/chromium npm run export-session
 *
 * The script opens a fresh, dedicated browser profile (your everyday profile is not
 * touched), waits until the ChatGPT composer is visible, then writes
 * ./chatgpt-session.json and prints the base64 value to paste into
 * CHATGPT_SESSION_STATE (Obot: the "ChatGPT session" field).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

const BASE = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
const OUT = path.resolve(process.env.OUT_FILE ?? "chatgpt-session.json");
const TIMEOUT_MIN = Number(process.env.LOGIN_TIMEOUT_MINUTES ?? 10);
const KEEP = /(^|\.)(chatgpt\.com|openai\.com)$/i;

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-login-"));
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH || undefined;
  const channel = executablePath ? undefined : process.env.BROWSER_CHANNEL || "chrome";
  const launch = (ch?: string) =>
    chromium.launchPersistentContext(profile, {
      headless: false,
      channel: ch,
      executablePath,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  let ctx;
  try {
    ctx = await launch(channel);
  } catch (err) {
    // No Google Chrome installed: fall back to Microsoft Edge when the channel was not chosen explicitly.
    if (executablePath || process.env.BROWSER_CHANNEL) throw err;
    process.stderr.write("Google Chrome not found, trying Microsoft Edge…\n");
    ctx = await launch("msedge");
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  process.stderr.write(`\nLog in to ChatGPT in the opened window (waiting up to ${TIMEOUT_MIN} min)…\n`);

  const composer = page.locator("#prompt-textarea, [data-testid='prompt-textarea'], div[contenteditable='true'][role='textbox']").first();
  const loginBtn = page.locator("[data-testid='login-button']").first();
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  while (Date.now() < deadline) {
    const ready = (await composer.isVisible().catch(() => false)) && !(await loginBtn.isVisible().catch(() => false));
    if (ready) break;
    await page.waitForTimeout(1500);
  }
  if (Date.now() >= deadline) throw new Error("Timed out waiting for login.");
  await page.waitForTimeout(3000); // let ChatGPT finish setting cookies

  const state = await ctx.storageState();
  const trimmed = {
    cookies: state.cookies.filter((c) => KEEP.test(c.domain.replace(/^\./, ""))),
    // Drop big localStorage caches (e.g. a ~1 MB statsig entry on auth.openai.com):
    // they are not needed for the login and would exceed env/Secret size limits.
    origins: state.origins
      .filter((o) => KEEP.test(new URL(o.origin).hostname))
      .map((o) => ({ ...o, localStorage: o.localStorage.filter((e) => e.name.length + e.value.length <= 2048) }))
      .filter((o) => o.localStorage.length > 0),
  };
  if (!trimmed.cookies.some((c) => c.name.startsWith("__Secure-next-auth.session-token"))) {
    process.stderr.write("Warning: no __Secure-next-auth.session-token cookie found; the export may not work.\n");
  }
  fs.writeFileSync(OUT, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const b64 = Buffer.from(JSON.stringify(trimmed)).toString("base64");
  process.stderr.write(`\nSaved ${trimmed.cookies.length} cookies to ${OUT} (${Math.round(b64.length / 1024)} KB as base64)\n`);
  process.stderr.write("Paste the following line into CHATGPT_SESSION_STATE (treat it like a password):\n\n");
  process.stdout.write(`${b64}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
