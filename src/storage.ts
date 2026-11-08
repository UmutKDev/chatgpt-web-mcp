import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { log } from "./logger.js";

export interface ImageRecord {
  id: string;
  jobId: string;
  file: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  prompt: string;
  finalPrompt: string;
  conversationId: string | null;
  conversationUrl: string;
  parentImageId?: string;
  captureMethod: string;
  createdAt: string;
  tags?: string[];
}

export interface ConversationRecord {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  imageIds: string[];
}

interface LibraryFile {
  version: 1;
  images: ImageRecord[];
  conversations: ConversationRecord[];
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

/** Image library on disk: files under outputDir plus a JSON index. */
export class ImageStore {
  private lib: LibraryFile;
  private readonly indexFile: string;

  constructor(
    private readonly outputDir: string,
    private readonly retentionDays: number,
    private readonly maxStorageMb: number,
  ) {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    this.indexFile = path.join(outputDir, "library.json");
    this.lib = this.read();
  }

  private read(): LibraryFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as LibraryFile;
      if (data.version === 1 && Array.isArray(data.images)) return { ...data, conversations: data.conversations ?? [] };
    } catch {
      /* new library */
    }
    return { version: 1, images: [], conversations: [] };
  }

  private flush(): void {
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.lib, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  save(input: Omit<ImageRecord, "id" | "file" | "bytes" | "sha256" | "createdAt"> & { data: Buffer }): ImageRecord {
    const id = newId("img");
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.outputDir, day);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.${EXT[input.mimeType] ?? "png"}`);
    fs.writeFileSync(file, input.data, { mode: 0o600 });
    const { data, ...rest } = input;
    const rec: ImageRecord = {
      ...rest,
      id,
      file,
      bytes: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    this.lib.images.push(rec);
    if (rec.conversationId) this.touchConversation(rec.conversationId, rec.conversationUrl, rec.prompt, rec.id);
    this.flush();
    return rec;
  }

  private touchConversation(id: string, url: string, title: string, imageId: string) {
    const now = new Date().toISOString();
    let conv = this.lib.conversations.find((c) => c.id === id);
    if (!conv) {
      conv = { id, url, title: title.slice(0, 120), createdAt: now, updatedAt: now, imageIds: [] };
      this.lib.conversations.push(conv);
    }
    conv.url = url;
    conv.updatedAt = now;
    conv.imageIds.push(imageId);
  }

  get(id: string): ImageRecord | undefined {
    return this.lib.images.find((i) => i.id === id);
  }

  readBytes(rec: ImageRecord): Buffer {
    return fs.readFileSync(rec.file);
  }

  list(opts: { limit?: number; conversationId?: string; query?: string; tag?: string } = {}): ImageRecord[] {
    let items = [...this.lib.images].reverse();
    if (opts.conversationId) items = items.filter((i) => i.conversationId === opts.conversationId);
    if (opts.tag) items = items.filter((i) => i.tags?.includes(opts.tag!));
    if (opts.query) {
      const q = opts.query.toLowerCase();
      items = items.filter((i) => i.prompt.toLowerCase().includes(q));
    }
    return items.slice(0, opts.limit ?? 20);
  }

  tag(id: string, tags: string[]): ImageRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    rec.tags = Array.from(new Set([...(rec.tags ?? []), ...tags]));
    this.flush();
    return rec;
  }

  delete(id: string): boolean {
    const idx = this.lib.images.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const [rec] = this.lib.images.splice(idx, 1);
    fs.rmSync(rec.file, { force: true });
    for (const c of this.lib.conversations) c.imageIds = c.imageIds.filter((x) => x !== id);
    this.flush();
    return true;
  }

  conversations(limit = 20): ConversationRecord[] {
    return [...this.lib.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  conversation(idOrUrl: string): ConversationRecord | undefined {
    return this.lib.conversations.find((c) => c.id === idOrUrl || c.url === idOrUrl);
  }

  stats() {
    const bytes = this.lib.images.reduce((s, i) => s + i.bytes, 0);
    return { images: this.lib.images.length, conversations: this.lib.conversations.length, megabytes: +(bytes / 1048576).toFixed(1) };
  }

  /** Deletes images past the retention window and trims the oldest beyond the size cap. */
  prune(): number {
    let removed = 0;
    const now = Date.now();
    if (this.retentionDays > 0) {
      const cutoff = now - this.retentionDays * 86_400_000;
      for (const rec of [...this.lib.images]) {
        if (Date.parse(rec.createdAt) < cutoff && this.delete(rec.id)) removed++;
      }
    }
    if (this.maxStorageMb > 0) {
      const cap = this.maxStorageMb * 1048576;
      let total = this.lib.images.reduce((s, i) => s + i.bytes, 0);
      while (total > cap && this.lib.images.length) {
        const oldest = this.lib.images[0];
        total -= oldest.bytes;
        this.delete(oldest.id);
        removed++;
      }
    }
    if (removed) log.info("pruned images", { removed });
    return removed;
  }
}
