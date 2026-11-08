#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertAllowedBaseUrl } from "./browser/manager.js";
import { loadConfig } from "./config.js";
import { FileSigner } from "./files.js";
import { startHttp } from "./http.js";
import { log } from "./logger.js";
import { createMcpServer } from "./server.js";
import { ImageService } from "./service.js";

async function main() {
  const cfg = loadConfig();
  log.setLevel(cfg.logLevel);
  assertAllowedBaseUrl(cfg);

  const svc = new ImageService(cfg);
  const signer = new FileSigner(cfg.fileUrlSecret);
  svc.store.prune();

  if (!svc.browser.hasConfiguredSession) {
    log.warn("no ChatGPT session configured: set CHATGPT_SESSION_STATE or CHATGPT_SESSION_TOKEN (tools will report LOGIN_REQUIRED)");
  }

  let closeHttp: (() => void) | undefined;
  if (cfg.transport === "stdio") {
    const server = createMcpServer(svc, signer);
    await server.connect(new StdioServerTransport());
    log.info("stdio transport ready");
  } else {
    const http = await startHttp(cfg, svc, signer);
    closeHttp = () => http.close();
  }

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    closeHttp?.();
    await svc.browser.persist();
    await svc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: err });
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
