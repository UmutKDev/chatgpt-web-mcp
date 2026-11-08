import type { Page } from "playwright-core";

import { UserFacingError } from "../errors.js";
import { log } from "../logger.js";
import { any, type Selectors } from "./selectors.js";

export interface PageRunOptions {
  prompt: string;
  /** Full URL of an existing conversation to continue. */
  conversationUrl?: string;
  /** URL used when starting a new chat (project URL, custom GPT, /images …). */
  startUrl: string;
  files: string[];
  maxImages: number;
  timeoutMs: number;
  readyTimeoutMs: number;
  maxImageBytes: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CapturedImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  sourceUrl: string;
  captureMethod: "authenticated_fetch" | "element_screenshot";
}

export interface PageRunResult {
  images: CapturedImage[];
  conversationUrl: string;
  conversationId: string | null;
  assistantText: string;
}

export type SessionStatus =
  | { state: "ready"; url: string }
  | { state: "login_required"; url: string; detail: string }
  | { state: "blocked"; url: string; detail: string }
  | { state: "unknown"; url: string; detail: string };

const BLOCKED_RE = /verify you are human|just a moment|checking your browser|unusual activity|captcha|security check/i;
const LOGIN_RE = /\b(log in|sign up|continue with google|continue with apple|welcome back)\b/i;
const RATE_LIMIT_RE =
  /(hit|reached) (the|your) (\w+ )?(plan )?limit|image generation (rate )?limit|you(?:'|’)ve (hit|reached).{0,40}limit|too many requests|try again (later|in|after)/i;
const REFUSAL_RE =
  /violate(s)? our (content )?polic|guardrails|similarity to third-party content|unable to (generate|create)|can(?:not|'t|’t) (generate|create|help with)|couldn(?:'|’)t (generate|create)|not able to (generate|create)|content policy/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function conversationIdFromUrl(url: string): string | null {
  const m = /\/c\/([0-9a-f-]{8,})/i.exec(url);
  return m ? m[1] : null;
}

interface ImgInfo {
  src: string;
  width: number;
  height: number;
  complete: boolean;
  turn: number;
}

export class ChatGPTPage {
  constructor(
    private readonly page: Page,
    private readonly sel: Selectors,
  ) {}

  get raw(): Page {
    return this.page;
  }

  async goto(url: string): Promise<void> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (err) {
      throw new UserFacingError("Could not open ChatGPT in the browser.", "NAVIGATION_FAILED", { retryable: true, cause: err });
    }
  }

  /** Classifies the current page: composer visible, login wall, challenge, or unknown. */
  async status(): Promise<SessionStatus> {
    const url = this.page.url();
    if (/auth\.openai\.com|\/auth\/login|\/log-in/i.test(url)) {
      return { state: "login_required", url, detail: "Redirected to the login page." };
    }
    const composerVisible = await this.page
      .locator(any(this.sel.composer))
      .first()
      .isVisible()
      .catch(() => false);
    const text = await this.bodyText(4000);
    const title = await this.page.title().catch(() => "");
    if (BLOCKED_RE.test(`${title}\n${text}`) && !composerVisible) {
      return { state: "blocked", url, detail: excerpt(`${title} ${text}`, BLOCKED_RE) };
    }
    const loginButton = await this.page
      .locator(any(this.sel.loginMarkers))
      .first()
      .isVisible()
      .catch(() => false);
    if (loginButton) {
      return { state: "login_required", url, detail: "ChatGPT shows a log-in button; the session cookie is missing or expired." };
    }
    if (composerVisible) return { state: "ready", url };
    if (LOGIN_RE.test(text) && text.length < 3000) {
      return { state: "login_required", url, detail: excerpt(text, LOGIN_RE) };
    }
    return { state: "unknown", url, detail: excerpt(text, /./) };
  }

  /** Waits for the composer, failing fast on a login wall and patiently on a challenge. */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: SessionStatus = { state: "unknown", url: this.page.url(), detail: "" };
    while (Date.now() < deadline) {
      last = await this.status();
      if (last.state === "ready") return;
      if (last.state === "login_required") {
        throw new UserFacingError("ChatGPT is not logged in for this server.", "LOGIN_REQUIRED", {
          hint: "Refresh CHATGPT_SESSION_STATE (npm run export-session) or CHATGPT_SESSION_TOKEN in the server configuration.",
        });
      }
      await this.dismissDialogs();
      await sleep(1500);
    }
    if (last.state === "blocked") {
      throw new UserFacingError("ChatGPT showed a human-verification challenge to the server's browser.", "BLOCKED_BY_CHALLENGE", {
        hint: "Use a residential BROWSER_PROXY_SERVER, run headful (HEADLESS=false with Xvfb), export a fresh session, or connect a real browser with CHATGPT_CDP_URL.",
        retryable: true,
      });
    }
    throw new UserFacingError("The ChatGPT composer did not appear in time.", "NAVIGATION_FAILED", {
      hint: `Last page state: ${last.detail.slice(0, 200)}. Selectors may need updating via CHATGPT_SELECTORS_JSON.`,
      retryable: true,
    });
  }

  private async dismissDialogs(): Promise<void> {
    // Onboarding / announcement modals block the composer.
    const dialog = this.page.locator("[role='dialog']").first();
    if (await dialog.isVisible().catch(() => false)) {
      const btn = dialog.locator("button:has-text('Okay'), button:has-text('Got it'), button:has-text('Dismiss'), button:has-text('Close'), [data-testid='close-button']").first();
      if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
      else await this.page.keyboard.press("Escape").catch(() => {});
    }
  }

  private async bodyText(max: number): Promise<string> {
    const text = await this.page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "");
    return text.slice(0, max);
  }

  private async turnCount(): Promise<number> {
    return this.page
      .locator(any(this.sel.assistantTurn))
      .count()
      .catch(() => 0);
  }

  private async lastAssistantText(): Promise<string> {
    const turns = this.page.locator(any(this.sel.assistantTurn));
    const n = await turns.count().catch(() => 0);
    if (!n) return "";
    return ((await turns.nth(n - 1).innerText().catch(() => "")) || "").trim();
  }

  private async isGenerating(): Promise<boolean> {
    return this.page
      .locator(any(this.sel.stop))
      .first()
      .isVisible()
      .catch(() => false);
  }

  private async listImages(): Promise<ImgInfo[]> {
    return this.page.evaluate(
      ({ imageSel, turnSel }) => {
        const turns = Array.from(document.querySelectorAll(turnSel));
        const seen = new Set<string>();
        const out: Array<{ src: string; width: number; height: number; complete: boolean; turn: number }> = [];
        for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(imageSel))) {
          const src = img.currentSrc || img.src;
          if (!src || seen.has(src) || src.startsWith("data:image/svg")) continue;
          const r = img.getBoundingClientRect();
          const style = getComputedStyle(img);
          if (r.width < 64 || r.height < 64 || style.visibility === "hidden" || style.display === "none") continue;
          if (/avatar|profile|logo|icon/i.test(img.alt || "")) continue;
          // Skip the blurred progressive preview ChatGPT shows while rendering.
          if (/blur\(/.test(style.filter) || /blur\(/.test(getComputedStyle(img.parentElement ?? img).filter)) continue;
          seen.add(src);
          const turn = turns.findIndex((t) => t.contains(img));
          out.push({
            src,
            width: img.naturalWidth || Math.round(r.width),
            height: img.naturalHeight || Math.round(r.height),
            complete: img.complete && img.naturalWidth > 0,
            turn,
          });
        }
        return out;
      },
      { imageSel: any(this.sel.generatedImage), turnSel: any(this.sel.assistantTurn) },
    );
  }

  private async uploadFiles(files: string[]): Promise<void> {
    if (!files.length) return;
    let input = this.page.locator(any(this.sel.fileInput)).first();
    if ((await input.count()) === 0) {
      const attach = this.page.locator(any(this.sel.attach)).first();
      if (await attach.isVisible().catch(() => false)) await attach.click().catch(() => {});
      input = this.page.locator(any(this.sel.fileInput)).first();
    }
    try {
      await input.setInputFiles(files, { timeout: 15_000 });
    } catch (err) {
      throw new UserFacingError("ChatGPT did not accept the reference image upload.", "UPLOAD_FAILED", { retryable: true, cause: err });
    }
    // Wait for upload spinners to go away and the send button to become enabled.
    const deadline = Date.now() + 60_000;
    await sleep(1000);
    while (Date.now() < deadline) {
      const pending = await this.page
        .locator(any(this.sel.uploadPending))
        .first()
        .isVisible()
        .catch(() => false);
      if (!pending) break;
      await sleep(750);
    }
  }

  private async typePrompt(prompt: string): Promise<void> {
    const composer = this.page.locator(any(this.sel.composer)).first();
    await composer.click({ timeout: 10_000 });
    const tag = await composer.evaluate((el) => el.tagName.toLowerCase()).catch(() => "div");
    if (tag === "textarea") {
      await composer.fill(prompt);
    } else {
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await this.page.keyboard.press("Backspace");
      await this.page.keyboard.insertText(prompt);
    }
  }

  private async userTurnCount(): Promise<number> {
    return this.page
      .locator(any(this.sel.userTurn))
      .count()
      .catch(() => 0);
  }

  private async composerText(): Promise<string> {
    return this.page
      .locator(any(this.sel.composer))
      .first()
      .evaluate((el) => ("value" in el ? String((el as HTMLTextAreaElement).value) : (el as HTMLElement).innerText) || "")
      .catch(() => "");
  }

  /** True once ChatGPT has taken the prompt: a new turn, the stop button, or an emptied composer. */
  private async promptAccepted(before: { turns: number; userTurns: number }): Promise<boolean> {
    if (await this.isGenerating()) return true;
    if ((await this.userTurnCount()) > before.userTurns) return true;
    if ((await this.turnCount()) > before.turns) return true;
    return (await this.composerText()).trim().length === 0;
  }

  /**
   * Sends the typed prompt and checks that ChatGPT accepted it. A click can be swallowed
   * (hidden duplicate button, overlay, page still hydrating), so each attempt uses a
   * different method and is verified before moving on.
   */
  private async submit(before: { turns: number; userTurns: number }): Promise<void> {
    const methods = ["click", "enter", "dom-click"] as const;
    for (const [i, method] of methods.entries()) {
      const send = this.page.locator(any(this.sel.send)).filter({ visible: true }).first();
      const deadline = Date.now() + (i === 0 ? 30_000 : 5_000);
      let ready = false;
      while (Date.now() < deadline) {
        if (await send.isEnabled().catch(() => false)) {
          ready = true;
          break;
        }
        await sleep(400);
      }
      if (method === "click" && ready) {
        await send.click({ timeout: 5_000 }).catch(() => {});
      } else if (method === "dom-click" && ready) {
        await send.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      } else {
        await this.page.locator(any(this.sel.composer)).first().focus().catch(() => {});
        await this.page.keyboard.press("Enter");
      }
      const verifyUntil = Date.now() + 8_000;
      while (Date.now() < verifyUntil) {
        if (await this.promptAccepted(before)) return;
        await sleep(400);
      }
      log.warn("prompt not accepted, retrying", { method });
    }
    throw new UserFacingError("ChatGPT did not accept the prompt: the send button had no effect.", "SEND_FAILED", {
      retryable: true,
      hint: "Run check_session with last_error_screenshot to see the page. If the UI changed, update the send selector via CHATGPT_SELECTORS_JSON.",
    });
  }

  /** Sends one prompt and returns the images ChatGPT produced in reply. */
  async run(opts: PageRunOptions): Promise<PageRunResult> {
    const progress = opts.onProgress ?? (() => {});
    const target = opts.conversationUrl || opts.startUrl;
    if (this.page.url() !== target) {
      progress("Opening ChatGPT");
      await this.goto(target);
    }
    await this.waitUntilReady(opts.readyTimeoutMs);

    const baseline = new Set((await this.listImages()).map((i) => i.src));
    const turnsBefore = await this.turnCount();
    const userTurnsBefore = await this.userTurnCount();

    if (opts.files.length) {
      progress(`Uploading ${opts.files.length} reference image(s)`);
      await this.uploadFiles(opts.files);
    }
    progress("Sending prompt");
    await this.typePrompt(opts.prompt);
    await this.submit({ turns: turnsBefore, userTurns: userTurnsBefore });

    const started = Date.now();
    const deadline = started + opts.timeoutMs;
    let stableKey = "";
    let stableSince = 0;
    let lastText = "";
    let textStableSince = 0;
    let lastProgress = 0;

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        await this.page.locator(any(this.sel.stop)).first().click({ timeout: 2000 }).catch(() => {});
        throw new UserFacingError("The job was cancelled.", "CANCELLED");
      }
      const generating = await this.isGenerating();
      const turns = await this.turnCount();
      const text = turns > turnsBefore ? await this.lastAssistantText() : "";

      if (!generating && text) {
        if (RATE_LIMIT_RE.test(text)) {
          throw new UserFacingError(`ChatGPT refused because of a usage limit: ${excerpt(text, RATE_LIMIT_RE)}`, "RATE_LIMITED", {
            retryable: true,
            hint: "Wait for the limit window shown by ChatGPT, or use another account.",
          });
        }
      }

      const fresh = (await this.listImages()).filter((i) => !baseline.has(i.src) && i.complete && i.width >= 256 && i.height >= 256);
      const key = fresh.map((i) => i.src).join("|");
      if (key && key === stableKey) {
        stableSince ||= Date.now();
      } else {
        stableKey = key;
        stableSince = key ? Date.now() : 0;
      }
      if (fresh.length && !generating && Date.now() - stableSince >= 2500) {
        progress(`Downloading ${Math.min(fresh.length, opts.maxImages)} image(s)`);
        const images = await this.capture(fresh.slice(0, opts.maxImages), opts.maxImageBytes);
        const conversationUrl = this.page.url();
        return { images, conversationUrl, conversationId: conversationIdFromUrl(conversationUrl), assistantText: text.slice(0, 2000) };
      }

      // Assistant answered with text only (refusal, clarifying question, limit message).
      if (!generating && !fresh.length && text) {
        if (text === lastText) {
          textStableSince ||= Date.now();
        } else {
          lastText = text;
          textStableSince = Date.now();
        }
        if (Date.now() - textStableSince >= 12_000) {
          const conversationUrl = this.page.url();
          if (REFUSAL_RE.test(text)) {
            throw new UserFacingError(`ChatGPT declined to create the image: ${excerpt(text, REFUSAL_RE)}`, "CONTENT_REFUSED", {
              hint: `Rephrase the prompt. Conversation: ${conversationUrl}`,
            });
          }
          throw new UserFacingError(`ChatGPT replied without an image: ${text.slice(0, 600)}`, "NO_IMAGE_RETURNED", {
            hint: `Answer it with refine_image / conversation "${conversationIdFromUrl(conversationUrl) ?? conversationUrl}", or make the prompt explicit ("Create an image of …").`,
          });
        }
      }

      if (Date.now() - lastProgress > 10_000) {
        lastProgress = Date.now();
        const secs = Math.round((Date.now() - started) / 1000);
        progress(generating ? `ChatGPT is generating (${secs}s)` : `Waiting for ChatGPT (${secs}s)`);
      }
      await sleep(1000);
    }
    throw new UserFacingError(`No image arrived within ${Math.round(opts.timeoutMs / 1000)} seconds.`, "GENERATION_TIMEOUT", {
      retryable: true,
      hint: `The image may still appear in the conversation: ${this.page.url()}`,
    });
  }

  private async capture(images: ImgInfo[], maxBytes: number): Promise<CapturedImage[]> {
    const out: CapturedImage[] = [];
    for (const img of images) {
      const payload = await this.page
        .evaluate(async (src) => {
          try {
            const res = await fetch(src, { credentials: "include" });
            if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };
            const blob = await res.blob();
            const buf = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return { ok: true as const, mime: blob.type, b64: btoa(bin) };
          } catch (e) {
            return { ok: false as const, error: String((e as Error)?.message ?? e) };
          }
        }, img.src)
        .catch((e: unknown) => ({ ok: false as const, error: String(e) }));

      if (payload.ok) {
        const data = Buffer.from(payload.b64, "base64");
        const mimeType = sniffMime(data) ?? (payload.mime || "image/png");
        if (data.length <= maxBytes && mimeType.startsWith("image/")) {
          out.push({ data, mimeType, width: img.width, height: img.height, sourceUrl: img.src, captureMethod: "authenticated_fetch" });
          continue;
        }
      } else {
        log.warn("image fetch failed, falling back to screenshot", { error: payload.error });
      }
      const handle = this.page.locator(`img[src="${cssEscape(img.src)}"]`).first();
      const shot = await handle.screenshot({ type: "png" }).catch(() => null);
      if (!shot) throw new UserFacingError("A generated image could not be downloaded from ChatGPT.", "NO_IMAGE_RETURNED", { retryable: true });
      out.push({ data: shot, mimeType: "image/png", width: img.width, height: img.height, sourceUrl: img.src, captureMethod: "element_screenshot" });
    }
    return out;
  }

  async screenshot(): Promise<Buffer | null> {
    return this.page.screenshot({ type: "png", fullPage: false }).catch(() => null);
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function excerpt(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, 300).replace(/\s+/g, " ").trim();
  const start = Math.max(0, m.index - 120);
  return text
    .slice(start, m.index + m[0].length + 240)
    .replace(/\s+/g, " ")
    .trim();
}

export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return null;
}
