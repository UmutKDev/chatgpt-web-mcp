import { EventEmitter } from "node:events";

import { toUserFacing, UserFacingError } from "./errors.js";
import { log } from "./logger.js";
import { newId } from "./storage.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  progress: (message: string) => void;
}

export interface Job<R = unknown> {
  id: string;
  kind: string;
  summary: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: string[];
  result?: R;
  error?: { code: string; message: string; hint?: string; retryable: boolean };
}

interface Internal<R> {
  job: Job<R>;
  run: (ctx: JobContext) => Promise<R>;
  abort: AbortController;
  done: Promise<void>;
  resolve: () => void;
}

/**
 * One ChatGPT account can only drive a limited number of generations at once, and the
 * composer is a shared UI, so jobs run through a small FIFO queue.
 */
export class JobQueue<R> extends EventEmitter {
  private readonly jobs = new Map<string, Internal<R>>();
  private readonly waiting: Internal<R>[] = [];
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
    private readonly keepFinished = 200,
  ) {
    super();
  }

  submit(kind: string, summary: string, run: (ctx: JobContext) => Promise<R>): Job<R> {
    if (this.waiting.length >= this.maxQueue) {
      throw new UserFacingError(`The image queue is full (${this.maxQueue} waiting). Try again shortly.`, "QUEUE_FULL", { retryable: true });
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const job: Job<R> = { id: newId("job"), kind, summary: summary.slice(0, 160), status: "queued", createdAt: new Date().toISOString(), progress: [] };
    const entry: Internal<R> = { job, run, abort: new AbortController(), done, resolve };
    this.jobs.set(job.id, entry);
    this.waiting.push(entry);
    this.trim();
    this.pump();
    return job;
  }

  private pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift()!;
      if (entry.job.status === "cancelled") continue;
      this.running++;
      void this.execute(entry).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async execute(entry: Internal<R>) {
    const { job } = entry;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const progress = (message: string) => {
      job.progress.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
      if (job.progress.length > 50) job.progress.shift();
      this.emit("progress", job.id, message);
    };
    try {
      job.result = await entry.run({ jobId: job.id, signal: entry.abort.signal, progress });
      job.status = "succeeded";
    } catch (err) {
      const e = toUserFacing(err);
      job.status = e.code === "CANCELLED" ? "cancelled" : "failed";
      job.error = { code: e.code, message: e.message, hint: e.hint, retryable: e.retryable };
      log.warn("job failed", { jobId: job.id, code: e.code, message: e.message, cause: (err as Error)?.cause });
    } finally {
      job.finishedAt = new Date().toISOString();
      entry.resolve();
      this.emit("done", job.id);
    }
  }

  get(id: string): Job<R> | undefined {
    return this.jobs.get(id)?.job;
  }

  /** Waits up to `ms` for the job to finish and returns its current snapshot. */
  async wait(id: string, ms: number): Promise<Job<R> | undefined> {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    if (ms > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([entry.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    }
    return entry.job;
  }

  cancel(id: string): Job<R> | undefined {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    if (entry.job.status === "queued") {
      entry.job.status = "cancelled";
      entry.job.finishedAt = new Date().toISOString();
      entry.resolve();
    } else if (entry.job.status === "running") {
      entry.abort.abort();
    }
    return entry.job;
  }

  list(limit = 20): Job<R>[] {
    return [...this.jobs.values()].map((e) => e.job).reverse().slice(0, limit);
  }

  position(id: string): number {
    return this.waiting.findIndex((e) => e.job.id === id);
  }

  stats() {
    return { running: this.running, queued: this.waiting.length, concurrency: this.concurrency };
  }

  private trim() {
    const finished = [...this.jobs.values()].filter((e) => e.job.finishedAt);
    for (const e of finished.slice(0, Math.max(0, finished.length - this.keepFinished))) this.jobs.delete(e.job.id);
  }
}
