import os from "node:os";
import path from "node:path";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer (got "${raw}")`);
  return Math.min(max, Math.max(min, n));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(name: string): string[] {
  return str(name)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Transport = "http" | "stdio";

export interface AppConfig {
  transport: Transport;
  host: string;
  port: number;
  mcpPath: string;
  /** Optional bearer token that every HTTP request must carry. */
  authToken: string;
  /** Public base URL used to build download links, e.g. https://obot.example.com/... */
  publicBaseUrl: string;
  /** Sign file download URLs with this secret (defaults to authToken or a random value). */
  fileUrlSecret: string;

  dataDir: string;
  outputDir: string;
  retentionDays: number;
  maxStorageMb: number;

  chatgptBaseUrl: string;
  /** Allow non-chatgpt.com base URLs (only for tests against the mock). */
  allowCustomBaseUrl: boolean;
  /** Playwright storageState as JSON, base64 JSON, or a file path. */
  sessionState: string;
  /** Raw value of the __Secure-next-auth.session-token cookie. */
  sessionToken: string;
  /** Persist the refreshed cookies to dataDir so restarts keep the session. */
  persistSession: boolean;
  /** Use a persistent Chromium profile directory instead of an ephemeral context. */
  profileDir: string;
  cdpUrl: string;
  allowRemoteCdp: boolean;
  headless: boolean;
  browserChannel: string;
  executablePath: string;
  userAgent: string;
  locale: string;
  timezone: string;
  proxyServer: string;
  proxyUsername: string;
  proxyPassword: string;

  defaultConversationUrl: string;
  generationTimeoutSec: number;
  syncWaitSec: number;
  readyTimeoutSec: number;
  maxImagesPerJob: number;
  maxImageBytes: number;
  maxInputImages: number;
  maxInputImageBytes: number;
  allowUrlInputs: boolean;
  allowedInputDirs: string[];
  maxQueueLength: number;
  maxConcurrentJobs: number;
  selectorsOverride: string;
  returnMode: "image" | "link" | "both";
  inlineMaxBytes: number;
  diagnostics: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const argTransport = argv.includes("--stdio") ? "stdio" : argv.includes("--http") ? "http" : "";
  const transport = (argTransport || str("MCP_TRANSPORT", "http")) as Transport;
  if (transport !== "http" && transport !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio" (got "${transport}")`);
  }

  const dataDir = path.resolve(str("DATA_DIR", path.join(os.homedir(), ".chatgpt-web-mcp")));
  const authToken = str("MCP_AUTH_TOKEN");
  const returnMode = str("RETURN_MODE", "both") as AppConfig["returnMode"];
  if (!["image", "link", "both"].includes(returnMode)) {
    throw new Error(`RETURN_MODE must be image, link or both (got "${returnMode}")`);
  }
  const logLevel = str("LOG_LEVEL", "info") as AppConfig["logLevel"];

  return {
    transport,
    host: str("HOST", "0.0.0.0"),
    port: int("PORT", 8099, 1, 65535),
    mcpPath: str("MCP_PATH", "/mcp"),
    authToken,
    publicBaseUrl: str("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    fileUrlSecret: str("FILE_URL_SECRET", authToken),

    dataDir,
    outputDir: path.resolve(str("OUTPUT_DIR", path.join(dataDir, "outputs"))),
    retentionDays: int("RETENTION_DAYS", 14, 0),
    maxStorageMb: int("MAX_STORAGE_MB", 2048, 0),

    chatgptBaseUrl: str("CHATGPT_BASE_URL", "https://chatgpt.com").replace(/\/+$/, ""),
    allowCustomBaseUrl: bool("ALLOW_CUSTOM_BASE_URL", false),
    sessionState: str("CHATGPT_SESSION_STATE"),
    sessionToken: str("CHATGPT_SESSION_TOKEN"),
    persistSession: bool("PERSIST_SESSION", true),
    profileDir: str("CHATGPT_PROFILE_DIR"),
    cdpUrl: str("CHATGPT_CDP_URL"),
    allowRemoteCdp: bool("ALLOW_REMOTE_CDP", false),
    headless: bool("HEADLESS", false),
    browserChannel: str("BROWSER_CHANNEL"),
    executablePath: str("BROWSER_EXECUTABLE_PATH"),
    userAgent: str("BROWSER_USER_AGENT"),
    locale: str("BROWSER_LOCALE", "en-US"),
    timezone: str("BROWSER_TIMEZONE", str("TZ", "UTC")),
    proxyServer: str("BROWSER_PROXY_SERVER"),
    proxyUsername: str("BROWSER_PROXY_USERNAME"),
    proxyPassword: str("BROWSER_PROXY_PASSWORD"),

    defaultConversationUrl: str("CHATGPT_DEFAULT_URL"),
    generationTimeoutSec: int("GENERATION_TIMEOUT_SECONDS", 300, 30, 1800),
    syncWaitSec: int("SYNC_WAIT_SECONDS", 240, 0, 1800),
    readyTimeoutSec: int("READY_TIMEOUT_SECONDS", 45, 5, 600),
    maxImagesPerJob: int("MAX_IMAGES_PER_JOB", 4, 1, 10),
    maxImageBytes: int("MAX_IMAGE_BYTES", 25 * 1024 * 1024, 1024),
    maxInputImages: int("MAX_INPUT_IMAGES", 8, 0, 20),
    maxInputImageBytes: int("MAX_INPUT_IMAGE_BYTES", 20 * 1024 * 1024, 1024),
    allowUrlInputs: bool("ALLOW_URL_INPUTS", true),
    allowedInputDirs: list("ALLOWED_INPUT_DIRS").map((d) => path.resolve(d)),
    maxQueueLength: int("MAX_QUEUE_LENGTH", 20, 1, 1000),
    maxConcurrentJobs: int("MAX_CONCURRENT_JOBS", 1, 1, 4),
    selectorsOverride: str("CHATGPT_SELECTORS_JSON"),
    returnMode,
    inlineMaxBytes: int("INLINE_MAX_BYTES", 4 * 1024 * 1024, 0),
    diagnostics: bool("DIAGNOSTICS", true),
    logLevel: ["debug", "info", "warn", "error"].includes(logLevel) ? logLevel : "info",
  };
}
