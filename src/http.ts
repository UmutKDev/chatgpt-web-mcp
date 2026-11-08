import crypto from "node:crypto";
import type { Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";

import type { AppConfig } from "./config.js";
import type { FileSigner } from "./files.js";
import { log } from "./logger.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import type { ImageService } from "./service.js";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

const SESSION_IDLE_MS = 60 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function startHttp(cfg: AppConfig, svc: ImageService, signer: FileSigner): Promise<Server> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "60mb" }));

  const sessions = new Map<string, SessionEntry>();

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.authToken) return next();
    const header = req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (token && safeEqual(token, cfg.authToken)) return next();
    res.status(401).set("WWW-Authenticate", "Bearer").json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, queue: svc.queue.stats(), sessions: sessions.size });
  });

  app.get("/readyz", (_req, res) => {
    const ready = svc.browser.hasConfiguredSession;
    res.status(ready ? 200 : 503).json({ ready, reason: ready ? undefined : "no ChatGPT session configured" });
  });

  app.get("/files/:id", (req, res) => {
    const id = String(req.params.id);
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? "");
    if (!signer.verify(id, exp, sig)) return void res.status(403).json({ error: "invalid or expired link" });
    const rec = svc.store.get(id);
    if (!rec) return void res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", rec.mimeType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Disposition", `inline; filename="${rec.id}.${rec.mimeType.split("/")[1]}"`);
    res.sendFile(rec.file);
  });

  app.post(cfg.mcpPath, auth, async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(sessionId ? 404 : 400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: sessionId ? "Session not found; re-initialize." : "Bad Request: no valid session ID" },
            id: null,
          });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeen: Date.now() });
            log.info("mcp session opened", { sessions: sessions.size });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = createMcpServer(svc, signer);
        await server.connect(transport);
        entry = { transport, lastSeen: Date.now() };
      }
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp request failed", { error: err });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) return void res.status(sessionId ? 404 : 400).send("Invalid or missing session ID");
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  };
  app.get(cfg.mcpPath, auth, sessionRequest);
  app.delete(cfg.mcpPath, auth, sessionRequest);

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sessions) {
      if (now - e.lastSeen > SESSION_IDLE_MS) {
        void e.transport.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweeper.unref();

  return new Promise((resolve) => {
    const httpServer = app.listen(cfg.port, cfg.host, () => {
      log.info("http transport listening", { host: cfg.host, port: cfg.port, path: cfg.mcpPath, auth: Boolean(cfg.authToken) });
      resolve(httpServer);
    });
    // Image jobs can keep a request open for minutes.
    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 65_000;
    httpServer.keepAliveTimeout = 65_000;
  });
}
