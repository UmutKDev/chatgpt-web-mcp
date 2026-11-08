import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";

import { ChatGPTPage, type SessionStatus } from "./browser/chatgpt-page.js";
import { BrowserManager } from "./browser/manager.js";
import { loadSelectors, type Selectors } from "./browser/selectors.js";
import type { AppConfig } from "./config.js";
import { UserFacingError } from "./errors.js";
import { resolveInputs } from "./inputs.js";
import { JobQueue, type Job, type JobContext } from "./jobs.js";
import { log } from "./logger.js";
import { ProfileStore, STYLE_PRESETS } from "./profiles.js";
import { buildPrompt, type AspectRatio, type PromptParts } from "./prompt-builder.js";
import { ImageStore, newId, type ImageRecord } from "./storage.js";

export interface ImageRequest {
  mode: PromptParts["mode"];
  prompt: string;
  images?: string[];
  aspectRatio?: AspectRatio;
  stylePreset?: string;
  style?: string;
  character?: string;
  characterProfile?: string;
  styleProfile?: string;
  useDefaultProfiles?: boolean;
  negative?: string;
  textInImage?: string;
  transparentBackground?: boolean;
  count?: number;
  /** conversation id, conversation URL, or an image id whose conversation should be continued */
  conversation?: string;
  startUrl?: string;
  temporaryChat?: boolean;
  rawPrompt?: boolean;
  parentImageId?: string;
}

export interface ImageJobResult {
  images: ImageRecord[];
  conversationId: string | null;
  conversationUrl: string;
  finalPrompt: string;
  assistantText: string;
  durationMs: number;
}

export class ImageService {
  readonly browser: BrowserManager;
  readonly store: ImageStore;
  readonly profiles: ProfileStore;
  readonly queue: JobQueue<ImageJobResult>;
  private readonly selectors: Selectors;
  private readonly freePages: Page[] = [];

  constructor(readonly cfg: AppConfig) {
    this.browser = new BrowserManager(cfg);
    this.store = new ImageStore(cfg.outputDir, cfg.retentionDays, cfg.maxStorageMb);
    this.profiles = new ProfileStore(cfg.dataDir);
    this.queue = new JobQueue<ImageJobResult>(cfg.maxConcurrentJobs, cfg.maxQueueLength);
    this.selectors = loadSelectors(cfg.selectorsOverride);
  }

  private startUrl(req: Pick<ImageRequest, "startUrl" | "temporaryChat">): string {
    const base = this.cfg.chatgptBaseUrl;
    let url = req.startUrl || this.cfg.defaultConversationUrl || `${base}/`;
    if (!/^https?:\/\//i.test(url)) url = `${base}/${url.replace(/^\/+/, "")}`;
    const parsed = new URL(url);
    if (parsed.origin !== new URL(base).origin) {
      throw new UserFacingError(`start_url must be on ${new URL(base).host}.`, "INVALID_INPUT");
    }
    if (req.temporaryChat) parsed.searchParams.set("temporary-chat", "true");
    return parsed.toString();
  }

  /** Maps a conversation id / URL / image id to a full conversation URL. */
  resolveConversation(ref: string): string {
    const r = ref.trim();
    const base = this.cfg.chatgptBaseUrl;
    if (/^img_/i.test(r)) {
      const rec = this.store.get(r);
      if (!rec) throw new UserFacingError(`Image ${r} is not in the library.`, "NOT_FOUND");
      if (!rec.conversationUrl) throw new UserFacingError(`Image ${r} has no ChatGPT conversation to continue.`, "INVALID_INPUT");
      return rec.conversationUrl;
    }
    if (/^https?:\/\//i.test(r)) {
      if (new URL(r).origin !== new URL(base).origin) throw new UserFacingError("Conversation URLs must be on the ChatGPT host.", "INVALID_INPUT");
      return r;
    }
    const known = this.store.conversation(r);
    if (known) return known.url;
    if (/^[0-9a-f-]{8,}$/i.test(r)) return `${base}/c/${r}`;
    throw new UserFacingError(`Unknown conversation "${r}".`, "NOT_FOUND");
  }

  private resolveStyle(req: ImageRequest): { style?: string; character?: string; refs: string[] } {
    const refs: string[] = [];
    const parts: string[] = [];
    if (req.stylePreset) {
      const preset = STYLE_PRESETS[req.stylePreset];
      if (!preset) throw new UserFacingError(`Unknown style preset "${req.stylePreset}". Call list_style_presets.`, "INVALID_INPUT");
      parts.push(preset);
    }
    const defaults = req.useDefaultProfiles === false ? {} : this.profiles.defaults();
    const styleName = req.styleProfile ?? defaults.style;
    if (styleName) {
      const p = this.profiles.get(styleName, "style");
      if (!p) throw new UserFacingError(`Style profile "${styleName}" not found.`, "NOT_FOUND");
      parts.push(p.description);
      refs.push(...p.referenceImageIds);
    }
    if (req.style) parts.push(req.style);

    let character = req.character;
    const charName = req.characterProfile ?? defaults.character;
    if (charName) {
      const p = this.profiles.get(charName, "character");
      if (!p) throw new UserFacingError(`Character profile "${charName}" not found.`, "NOT_FOUND");
      character = [p.description, character].filter(Boolean).join(" ");
      refs.push(...p.referenceImageIds);
    }
    return { style: parts.join(" ") || undefined, character, refs };
  }

  submit(req: ImageRequest): Job<ImageJobResult> {
    if (!req.prompt.trim() && req.mode !== "variation") throw new UserFacingError("prompt must not be empty.", "INVALID_INPUT");
    if (req.prompt.length > 30_000) throw new UserFacingError("prompt is longer than 30,000 characters.", "INVALID_INPUT");
    // Resolve references eagerly so bad input fails before queueing.
    const conversationUrl = req.conversation ? this.resolveConversation(req.conversation) : undefined;
    const startUrl = this.startUrl(req);
    const { style, character, refs } = this.resolveStyle(req);
    const imageRefs = [...(req.images ?? []), ...refs];
    const count = Math.min(Math.max(req.count ?? 1, 1), this.cfg.maxImagesPerJob);

    return this.queue.submit(req.mode, req.prompt, (ctx) =>
      this.execute({ ...req, count }, { conversationUrl, startUrl, style, character, imageRefs }, ctx),
    );
  }

  private async acquirePage(): Promise<ChatGPTPage> {
    let page = this.freePages.pop();
    while (page && page.isClosed()) page = this.freePages.pop();
    page ??= await this.browser.newPage();
    return new ChatGPTPage(page, this.selectors);
  }

  private release(page: ChatGPTPage) {
    if (!page.raw.isClosed()) this.freePages.push(page.raw);
  }

  private async execute(
    req: ImageRequest & { count: number },
    plan: { conversationUrl?: string; startUrl: string; style?: string; character?: string; imageRefs: string[] },
    ctx: JobContext,
  ): Promise<ImageJobResult> {
    const started = Date.now();
    const workDir = path.join(this.cfg.dataDir, "tmp", newId("w"));
    let page: ChatGPTPage | null = null;
    try {
      ctx.progress("Preparing inputs");
      const inputs = await resolveInputs(plan.imageRefs, this.cfg, this.store, workDir);
      const firstPrompt = buildPrompt({
        prompt: req.prompt,
        mode: req.mode,
        aspectRatio: req.aspectRatio,
        style: plan.style,
        character: plan.character,
        negative: req.negative,
        textInImage: req.textInImage,
        transparentBackground: req.transparentBackground,
        referenceCount: inputs.length,
        raw: req.rawPrompt,
      });

      page = await this.acquirePage();
      const images: ImageRecord[] = [];
      let conversationUrl = plan.conversationUrl;
      let conversationId: string | null = null;
      let assistantText = "";
      const parent = req.parentImageId ?? inputs.find((i) => i.libraryId)?.libraryId;

      for (let i = 0; i < req.count; i++) {
        const prompt = i === 0 ? firstPrompt : buildPrompt({ prompt: "", mode: "variation", aspectRatio: req.aspectRatio });
        if (req.count > 1) ctx.progress(`Image ${i + 1} of ${req.count}`);
        const result = await page.run({
          prompt,
          conversationUrl: i === 0 ? conversationUrl : undefined,
          startUrl: i === 0 && !conversationUrl ? plan.startUrl : page.raw.url(),
          files: i === 0 ? inputs.map((x) => x.file) : [],
          maxImages: req.count - images.length,
          timeoutMs: this.cfg.generationTimeoutSec * 1000,
          readyTimeoutMs: this.cfg.readyTimeoutSec * 1000,
          maxImageBytes: this.cfg.maxImageBytes,
          signal: ctx.signal,
          onProgress: ctx.progress,
        });
        conversationUrl = result.conversationUrl;
        conversationId = result.conversationId;
        assistantText = result.assistantText;
        for (const img of result.images) {
          images.push(
            this.store.save({
              data: img.data,
              mimeType: img.mimeType,
              width: img.width,
              height: img.height,
              jobId: ctx.jobId,
              prompt: req.prompt,
              finalPrompt: prompt,
              conversationId,
              conversationUrl,
              parentImageId: parent,
              captureMethod: img.captureMethod,
            }),
          );
        }
        if (images.length >= req.count) break;
      }
      await this.browser.persist();
      this.store.prune();
      return { images, conversationId, conversationUrl: conversationUrl ?? "", finalPrompt: firstPrompt, assistantText, durationMs: Date.now() - started };
    } catch (err) {
      if (page && this.cfg.diagnostics) await this.saveDiagnostic(page);
      if (err instanceof UserFacingError && err.code === "BROWSER_START_FAILED") await this.browser.restart();
      throw err;
    } finally {
      if (page) this.release(page);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async saveDiagnostic(page: ChatGPTPage) {
    const shot = await page.screenshot();
    if (!shot) return;
    const dir = path.join(this.cfg.dataDir, "diagnostics");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    fs.writeFileSync(file, shot, { mode: 0o600 });
    // Keep only the newest 20 screenshots.
    const files = fs.readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
    log.info("saved diagnostic screenshot", { file });
  }

  latestDiagnostic(): Buffer | null {
    const dir = path.join(this.cfg.dataDir, "diagnostics");
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).sort();
    return files.length ? fs.readFileSync(path.join(dir, files[files.length - 1])) : null;
  }

  /** Opens ChatGPT and reports whether the configured session is usable. */
  async checkSession(withScreenshot: boolean): Promise<{ status: SessionStatus; screenshot: Buffer | null }> {
    if (!this.browser.hasConfiguredSession) {
      return {
        status: { state: "login_required", url: "", detail: "No session configured. Set CHATGPT_SESSION_STATE or CHATGPT_SESSION_TOKEN." },
        screenshot: null,
      };
    }
    const page = await this.acquirePage();
    try {
      await page.goto(this.startUrl({}));
      const deadline = Date.now() + this.cfg.readyTimeoutSec * 1000;
      let status = await page.status();
      while (status.state !== "ready" && status.state !== "login_required" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        status = await page.status();
      }
      if (status.state === "ready") await this.browser.persist();
      return { status, screenshot: withScreenshot ? await page.screenshot() : null };
    } finally {
      this.release(page);
    }
  }

  async close() {
    await this.browser.close();
  }
}
