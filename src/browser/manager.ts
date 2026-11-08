import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import type { AppConfig } from "../config.js";
import { UserFacingError } from "../errors.js";
import { log } from "../logger.js";
import { cookiesFromToken, fingerprint, parseSessionState, SessionStore, type StorageState } from "./session-state.js";

const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
`;

export function assertAllowedBaseUrl(cfg: AppConfig): void {
  let url: URL;
  try {
    url = new URL(cfg.chatgptBaseUrl);
  } catch {
    throw new Error(`CHATGPT_BASE_URL is not a valid URL: ${cfg.chatgptBaseUrl}`);
  }
  const official = url.protocol === "https:" && /(^|\.)chatgpt\.com$/i.test(url.hostname);
  if (!official && !cfg.allowCustomBaseUrl) {
    throw new Error("CHATGPT_BASE_URL must be https://chatgpt.com unless ALLOW_CUSTOM_BASE_URL=true (test mode).");
  }
}

function isLoopback(urlText: string): boolean {
  try {
    const { hostname } = new URL(urlText);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/** Owns the Chromium process / context and the persisted ChatGPT cookies. */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private starting: Promise<BrowserContext> | null = null;
  private ownsBrowser = false;
  private readonly store: SessionStore;
  private readonly sourceFingerprint: string;

  constructor(private readonly cfg: AppConfig) {
    this.store = new SessionStore(cfg.dataDir);
    this.sourceFingerprint = fingerprint(cfg.sessionState, cfg.sessionToken);
  }

  get hasConfiguredSession(): boolean {
    return Boolean(this.cfg.sessionState || this.cfg.sessionToken || this.cfg.profileDir || this.cfg.cdpUrl);
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async newPage(): Promise<Page> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    return page;
  }

  private initialState(): StorageState | null {
    if (this.cfg.persistSession) {
      const saved = this.store.load(this.sourceFingerprint);
      if (saved) {
        log.info("using persisted ChatGPT session state");
        return saved;
      }
    }
    if (this.cfg.sessionState) {
      try {
        return parseSessionState(this.cfg.sessionState);
      } catch (err) {
        throw new UserFacingError(`Could not read CHATGPT_SESSION_STATE: ${(err as Error).message}`, "LOGIN_REQUIRED", {
          hint: "Run `npm run export-session` on a desktop and paste the printed value.",
        });
      }
    }
    if (this.cfg.sessionToken) {
      return { cookies: cookiesFromToken(this.cfg.sessionToken, this.cfg.chatgptBaseUrl), origins: [] };
    }
    return null;
  }

  private launchArgs(): string[] {
    return [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--window-size=1440,1000",
      `--lang=${this.cfg.locale}`,
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ];
  }

  private async start(): Promise<BrowserContext> {
    const cfg = this.cfg;
    try {
      if (cfg.cdpUrl) {
        if (!isLoopback(cfg.cdpUrl) && !cfg.allowRemoteCdp) {
          throw new UserFacingError("CHATGPT_CDP_URL must point to loopback unless ALLOW_REMOTE_CDP=true.", "BROWSER_START_FAILED");
        }
        this.browser = await chromium.connectOverCDP(cfg.cdpUrl);
        this.ownsBrowser = false;
        this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
        log.info("connected to external browser over CDP");
      } else {
        const state = this.initialState();
        const common = {
          headless: cfg.headless,
          channel: cfg.browserChannel || undefined,
          executablePath: cfg.executablePath || undefined,
          args: this.launchArgs(),
          ignoreDefaultArgs: ["--enable-automation"],
          proxy: cfg.proxyServer
            ? { server: cfg.proxyServer, username: cfg.proxyUsername || undefined, password: cfg.proxyPassword || undefined }
            : undefined,
        };
        const contextOpts = {
          viewport: { width: 1440, height: 1000 },
          locale: cfg.locale,
          timezoneId: cfg.timezone,
          userAgent: cfg.userAgent || undefined,
          acceptDownloads: true,
        };
        if (cfg.profileDir) {
          fs.mkdirSync(cfg.profileDir, { recursive: true, mode: 0o700 });
          this.context = await chromium.launchPersistentContext(cfg.profileDir, { ...common, ...contextOpts });
          if (state?.cookies.length) await this.context.addCookies(state.cookies as never);
        } else {
          this.browser = await chromium.launch(common);
          this.context = await this.browser.newContext({ ...contextOpts, storageState: (state ?? undefined) as never });
        }
        this.ownsBrowser = true;
        log.info("browser started", { headless: cfg.headless, persistentProfile: Boolean(cfg.profileDir), hasSession: Boolean(state) });
      }
      await this.context.addInitScript(STEALTH_INIT);
      this.context.on("close", () => {
        log.warn("browser context closed");
        this.context = null;
        this.browser = null;
      });
      return this.context;
    } catch (err) {
      this.context = null;
      this.browser = null;
      if (err instanceof UserFacingError) throw err;
      log.error("browser start failed", { error: err });
      throw new UserFacingError("Could not start the browser for ChatGPT.", "BROWSER_START_FAILED", {
        hint: "Check BROWSER_EXECUTABLE_PATH / BROWSER_CHANNEL, or that the container image ships Chromium.",
        retryable: true,
        cause: err,
      });
    }
  }

  /** Saves refreshed cookies so a restart keeps the (rotated) ChatGPT session. */
  async persist(): Promise<void> {
    if (!this.cfg.persistSession || !this.context || this.cfg.cdpUrl) return;
    try {
      const state = (await this.context.storageState()) as StorageState;
      this.store.save(this.sourceFingerprint, state);
    } catch (err) {
      log.warn("could not persist session state", { error: err });
    }
  }

  async exportState(): Promise<StorageState | null> {
    if (!this.context) return null;
    return (await this.context.storageState()) as StorageState;
  }

  async restart(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    const ctx = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    if (!this.ownsBrowser) return;
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
