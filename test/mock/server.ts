/**
 * A tiny imitation of the ChatGPT web UI used for end-to-end tests. It reproduces the
 * parts the driver relies on: the composer, send/stop buttons, file input, assistant
 * turns, progressive (blurred) image previews, /c/<id> conversation URLs and
 * cookie-protected image downloads.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

import express from "express";

const COOKIE = "__Secure-next-auth.session-token";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Solid-colour PNG of the given size. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  image?: string;
}

const PAGE = (turns: Turn[]) => `<!doctype html>
<html><head><title>ChatGPT</title>
<style>
  body{font-family:sans-serif;margin:0} main{padding:20px;min-height:600px}
  article{margin:12px 0;padding:8px;border:1px solid #ddd}
  img.gen{width:512px;height:512px;display:block}
  .blur{filter:blur(12px)}
  #composer{position:fixed;bottom:0;left:0;right:0;padding:12px;background:#fff;border-top:1px solid #ccc}
  #prompt-textarea{min-height:40px;border:1px solid #999;padding:6px;width:70%;display:inline-block}
</style></head>
<body>
<main>
${turns
  .map(
    (t) =>
      `<article data-testid="conversation-turn" ${t.role === "assistant" ? "data-message-author-role=\"assistant\"" : "data-message-author-role=\"user\""}>` +
      `<div class="text">${t.text}</div>${t.image ? `<img class="gen" alt="Generated image" src="${t.image}">` : ""}</article>`,
  )
  .join("\n")}
</main>
<div id="composer">
  <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
  <input type="file" accept="image/*" multiple style="display:none" id="file">
  <button data-testid="send-button" id="send" disabled>Send</button>
</div>
<script>
  const box = document.getElementById('prompt-textarea');
  const send = document.getElementById('send');
  const file = document.getElementById('file');
  let uploads = 0;
  box.addEventListener('input', () => { send.disabled = !box.innerText.trim(); });
  file.addEventListener('change', () => { uploads = file.files.length; });
  async function submit() {
    const text = box.innerText.trim();
    if (!text) return;
    box.innerText = ''; send.disabled = true;
    const user = document.createElement('article');
    user.setAttribute('data-message-author-role','user');
    user.textContent = text;
    document.querySelector('main').appendChild(user);
    const stop = document.createElement('button');
    stop.setAttribute('data-testid','stop-button'); stop.textContent='Stop';
    document.getElementById('composer').appendChild(stop);
    const res = await fetch(location.pathname.startsWith('/c/') ? location.pathname + '/message' : '/new/message', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text, uploads })
    }).then(r => r.json());
    uploads = 0;
    if (res.conversation && !location.pathname.startsWith('/c/')) history.pushState({}, '', '/c/' + res.conversation);
    const turn = document.createElement('article');
    turn.setAttribute('data-message-author-role','assistant');
    turn.innerHTML = '<div class="text"></div>';
    document.querySelector('main').appendChild(turn);
    setTimeout(() => {
      if (res.image) {
        const img = document.createElement('img');
        img.className = 'gen blur'; img.alt = 'Generated image'; img.src = res.preview;
        turn.appendChild(img);
        setTimeout(() => { img.className = 'gen'; img.src = res.image; }, ${Number(process.env.MOCK_RENDER_MS ?? 1500)});
        setTimeout(() => { stop.remove(); turn.querySelector('.text').textContent = res.text; }, ${Number(process.env.MOCK_RENDER_MS ?? 1500)} + 300);
      } else {
        turn.querySelector('.text').textContent = res.text; stop.remove();
      }
    }, 500);
  }
  send.addEventListener('click', submit);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
</script>
</body></html>`;

const LOGIN_PAGE = `<!doctype html><html><head><title>ChatGPT</title></head><body><main><h1>Welcome back</h1>
<button data-testid="login-button">Log in</button><button data-testid="signup-button">Sign up</button></main></body></html>`;

export interface MockChatGPT {
  url: string;
  token: string;
  stats: { messages: Array<{ text: string; uploads: number; conversation: string }> };
  close: () => Promise<void>;
}

export async function startMock(port = 0, token = "test-session-token"): Promise<MockChatGPT> {
  const app = express();
  app.use(express.json());
  const conversations = new Map<string, Turn[]>();
  const images = new Map<string, Buffer>();
  const stats: MockChatGPT["stats"] = { messages: [] };

  const authed = (req: express.Request) => (req.headers.cookie ?? "").split(/;\s*/).some((c) => c === `${COOKIE}=${token}`);

  app.get(["/", "/g/:gizmo/project"], (req, res) => {
    res.type("html").send(authed(req) ? PAGE([]) : LOGIN_PAGE);
  });
  app.get("/c/:id", (req, res) => {
    if (!authed(req)) return void res.type("html").send(LOGIN_PAGE);
    res.type("html").send(PAGE(conversations.get(req.params.id) ?? []));
  });

  const reply = (convId: string, text: string, uploads: number) => {
    stats.messages.push({ text, uploads, conversation: convId });
    const turns = conversations.get(convId) ?? [];
    conversations.set(convId, turns);
    turns.push({ role: "user", text });
    if (/REFUSE/.test(text)) {
      const t = "I can't create that image because it may violate our content policy.";
      turns.push({ role: "assistant", text: t });
      return { conversation: convId, text: t };
    }
    if (/LIMIT/.test(text)) {
      const t = "You've hit the plus plan limit for image generations requests. You can create more images when the limit resets in 2 hours.";
      turns.push({ role: "assistant", text: t });
      return { conversation: convId, text: t };
    }
    if (/QUESTION/.test(text)) {
      const t = "Sure! Before I start, what colour should the car be?";
      turns.push({ role: "assistant", text: t });
      return { conversation: convId, text: t };
    }
    const id = `file_${crypto.randomBytes(6).toString("hex")}`;
    const seed = crypto.createHash("md5").update(id).digest();
    images.set(id, makePng(640, 480, [seed[0], seed[1], seed[2]]));
    const imgUrl = `/backend-api/estuary/content?id=${id}`;
    const t = uploads ? `Here is your edited image (used ${uploads} upload(s)).` : "Here is your image.";
    turns.push({ role: "assistant", text: t, image: imgUrl });
    return { conversation: convId, text: t, image: imgUrl, preview: `${imgUrl}&preview=1` };
  };

  app.post("/new/message", (req, res) => {
    if (!authed(req)) return void res.status(401).json({});
    res.json(reply(crypto.randomUUID(), req.body.text, req.body.uploads));
  });
  app.post("/c/:id/message", (req, res) => {
    if (!authed(req)) return void res.status(401).json({});
    res.json(reply(req.params.id, req.body.text, req.body.uploads));
  });
  app.get("/backend-api/estuary/content", (req, res) => {
    if (!authed(req)) return void res.status(403).end();
    const img = images.get(String(req.query.id));
    if (!img) return void res.status(404).end();
    res.type("png").send(req.query.preview ? makePng(640, 480, [200, 200, 200]) : img);
  });

  return new Promise((resolve) => {
    const srv = app.listen(port, "127.0.0.1", () => {
      const { port: p } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${p}`, token, stats, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  const m = await startMock(Number(process.env.MOCK_PORT ?? 8787));
  process.stderr.write(`mock ChatGPT on ${m.url} (session token: ${m.token})\n`);
}
