import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toUserFacing, UserFacingError } from "./errors.js";
import type { FileSigner } from "./files.js";
import type { Job } from "./jobs.js";
import { STYLE_PRESETS } from "./profiles.js";
import { ASPECT_RATIOS, type AspectRatio } from "./prompt-builder.js";
import type { ImageJobResult, ImageRequest, ImageService } from "./service.js";
import type { ImageRecord } from "./storage.js";

export const SERVER_NAME = "chatgpt-web-mcp";
export const SERVER_VERSION = "0.1.0";

const aspect = z
  .enum(Object.keys(ASPECT_RATIOS) as [AspectRatio, ...AspectRatio[]])
  .optional()
  .describe("Requested aspect ratio. ChatGPT treats it as a strong hint, not an exact pixel size.");

const common = {
  aspect_ratio: aspect,
  style_preset: z.string().optional().describe("Built-in art direction (see list_style_presets), e.g. photorealistic, logo, anime."),
  style: z.string().max(2000).optional().describe("Free-text art direction appended to the prompt."),
  style_profile: z.string().optional().describe("Saved style profile name."),
  character_profile: z.string().optional().describe("Saved character profile name for a consistent person/mascot."),
  character: z.string().max(2000).optional().describe("Free-text character description to keep consistent."),
  use_default_profiles: z.boolean().optional().describe("Apply the default character/style profiles (default true)."),
  negative_prompt: z.string().max(1000).optional().describe("Things to avoid."),
  text_in_image: z.string().max(300).optional().describe("Exact text that must appear in the image."),
  transparent_background: z.boolean().optional().describe("Ask for an isolated subject on a transparent background."),
  raw_prompt: z.boolean().optional().describe("Send the prompt exactly as given, without the server's instruction wrapper."),
  wait: z.boolean().optional().describe("Wait for the result (default true). false returns a job_id immediately; poll with get_job."),
};

const imageRefs = z
  .array(z.string())
  .max(20)
  .describe("Image references: library ids (img_…), https URLs, data: URIs, or base64. Local paths only inside ALLOWED_INPUT_DIRS.");

function text(obj: unknown): { type: "text"; text: string } {
  return { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) };
}

function fail(err: unknown): CallToolResult {
  const e = toUserFacing(err);
  return { isError: true, content: [text({ error: e.code, message: e.message, hint: e.hint, retryable: e.retryable })] };
}

export function createMcpServer(svc: ImageService, signer: FileSigner): McpServer {
  const cfg = svc.cfg;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {} },
      instructions:
        "Generates and edits images with the operator's ChatGPT account through the ChatGPT web app. " +
        "Use generate_image for new images, edit_image to change an uploaded image, refine_image to iterate inside the same ChatGPT conversation (best for consistency), " +
        "and create_variations for alternatives. Results are stored in a library (list_images/get_image). Long generations return a job_id: poll get_job with wait_seconds.",
    },
  );

  const describeImage = (rec: ImageRecord) => ({
    image_id: rec.id,
    mime_type: rec.mimeType,
    width: rec.width,
    height: rec.height,
    bytes: rec.bytes,
    resource_uri: `image://${rec.id}`,
    download_url: cfg.publicBaseUrl ? signer.url(cfg.publicBaseUrl, rec.id) : undefined,
    conversation_id: rec.conversationId,
    created_at: rec.createdAt,
    ...(rec.parentImageId ? { parent_image_id: rec.parentImageId } : {}),
    ...(rec.tags?.length ? { tags: rec.tags } : {}),
  });

  const imageContent = (recs: ImageRecord[]): CallToolResult["content"] => {
    const out: CallToolResult["content"] = [];
    let budget = cfg.inlineMaxBytes;
    for (const rec of recs) {
      if (cfg.returnMode !== "link" && rec.bytes <= budget) {
        out.push({ type: "image", data: svc.store.readBytes(rec).toString("base64"), mimeType: rec.mimeType });
        budget -= rec.bytes;
      }
      if (cfg.returnMode !== "image") {
        out.push({ type: "resource_link", uri: `image://${rec.id}`, name: `${rec.id}`, mimeType: rec.mimeType, description: rec.prompt.slice(0, 200) });
      }
    }
    return out;
  };

  const jobView = (job: Job<ImageJobResult>) => ({
    job_id: job.id,
    status: job.status,
    kind: job.kind,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    queue_position: job.status === "queued" ? svc.queue.position(job.id) + 1 : undefined,
    last_progress: job.progress.at(-1),
    error: job.error,
    result: job.result
      ? {
          conversation_id: job.result.conversationId,
          conversation_url: job.result.conversationUrl,
          duration_seconds: Math.round(job.result.durationMs / 1000),
          assistant_text: job.result.assistantText || undefined,
          images: job.result.images.map(describeImage),
        }
      : undefined,
  });

  const jobResult = (job: Job<ImageJobResult>): CallToolResult => {
    if (job.status === "succeeded" && job.result) {
      return { content: [text(jobView(job)), ...imageContent(job.result.images)], structuredContent: jobView(job) as Record<string, unknown> };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      return { isError: true, content: [text(jobView(job))] };
    }
    return {
      content: [
        text({
          ...jobView(job),
          next_step: `Still ${job.status}. Call get_job with job_id "${job.id}" and wait_seconds (up to ${cfg.syncWaitSec}) to collect the image.`,
        }),
      ],
    };
  };

  /** Submits a job and, unless wait=false, waits for it while streaming progress notifications. */
  const runJob = async (req: ImageRequest, wait: boolean | undefined, extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> }) => {
    const job = svc.submit(req);
    if (wait === false || cfg.syncWaitSec === 0) return jobResult(job);
    const token = extra._meta?.progressToken;
    let step = 0;
    const onProgress = (id: string, message: string) => {
      if (id !== job.id || token === undefined) return;
      step++;
      void extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message } } as never)
        .catch(() => {});
    };
    svc.queue.on("progress", onProgress);
    try {
      const done = await svc.queue.wait(job.id, cfg.syncWaitSec * 1000);
      return jobResult(done ?? job);
    } finally {
      svc.queue.off("progress", onProgress);
    }
  };

  const toRequest = (a: Record<string, unknown>, mode: ImageRequest["mode"]): ImageRequest => ({
    mode,
    prompt: String(a.prompt ?? a.instruction ?? ""),
    images: (a.images as string[] | undefined) ?? undefined,
    aspectRatio: a.aspect_ratio as AspectRatio | undefined,
    stylePreset: a.style_preset as string | undefined,
    style: a.style as string | undefined,
    styleProfile: a.style_profile as string | undefined,
    characterProfile: a.character_profile as string | undefined,
    character: a.character as string | undefined,
    useDefaultProfiles: a.use_default_profiles as boolean | undefined,
    negative: a.negative_prompt as string | undefined,
    textInImage: a.text_in_image as string | undefined,
    transparentBackground: a.transparent_background as boolean | undefined,
    rawPrompt: a.raw_prompt as boolean | undefined,
    count: a.count as number | undefined,
    conversation: a.conversation as string | undefined,
    startUrl: a.start_url as string | undefined,
    temporaryChat: a.temporary_chat as boolean | undefined,
  });

  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Create new image(s) from a text prompt with ChatGPT's image generation. Optionally attach reference images, apply a style preset or saved profiles, and continue an existing conversation. Returns the image inline plus a library id.",
      inputSchema: {
        prompt: z.string().min(1).max(30_000).describe("What to create. Be concrete about subject, setting, composition and mood."),
        images: imageRefs.optional(),
        count: z.number().int().min(1).max(10).optional().describe(`How many images (sequential requests, max ${cfg.maxImagesPerJob}).`),
        conversation: z.string().optional().describe("Continue this ChatGPT conversation (conversation id, URL, or an image id from it)."),
        start_url: z.string().optional().describe("Start a new chat at this ChatGPT URL instead of the default (a Project, custom GPT, or /images)."),
        temporary_chat: z.boolean().optional().describe("Use a temporary chat that is not saved in the ChatGPT history."),
        ...common,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a, extra) => {
      try {
        return await runJob(toRequest(a, "generate"), a.wait, extra as never);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit image",
      description:
        "Edit an existing image with a natural-language instruction (change background, add/remove objects, restyle, combine). The first image is edited; extra images act as references.",
      inputSchema: {
        images: imageRefs.min(1),
        instruction: z.string().min(1).max(30_000).describe("What to change. Mention what must stay the same."),
        ...common,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a, extra) => {
      try {
        const req = toRequest(a, "edit");
        req.parentImageId = a.images.find((r) => /^img_/i.test(r));
        return await runJob(req, a.wait, extra as never);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "refine_image",
    {
      title: "Refine image in its conversation",
      description:
        "Iterate on an image inside the same ChatGPT conversation that produced it (\"make the sky orange\", \"same character, now sitting\"). Keeps context, so it is the most consistent way to make successive edits.",
      inputSchema: {
        image_id: z.string().optional().describe("Library image id to refine (its conversation is continued)."),
        conversation: z.string().optional().describe("Alternatively, a conversation id or URL."),
        instruction: z.string().min(1).max(30_000),
        aspect_ratio: aspect,
        raw_prompt: common.raw_prompt,
        wait: common.wait,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a, extra) => {
      try {
        const ref = a.image_id ?? a.conversation;
        if (!ref) throw new UserFacingError("Pass image_id or conversation.", "INVALID_INPUT");
        const req = toRequest({ ...a, conversation: ref, use_default_profiles: false }, "refine");
        req.parentImageId = a.image_id;
        return await runJob(req, a.wait, extra as never);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_variations",
    {
      title: "Create variations",
      description: "Produce alternative versions of an image. With image_id the original conversation is continued; with images the picture is uploaded to a new chat.",
      inputSchema: {
        image_id: z.string().optional(),
        images: imageRefs.optional(),
        count: z.number().int().min(1).max(10).optional().describe("Number of variations (default 2)."),
        guidance: z.string().max(2000).optional().describe("What to vary (e.g. colour palette, camera angle)."),
        aspect_ratio: aspect,
        wait: common.wait,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a, extra) => {
      try {
        const count = a.count ?? 2;
        const guidance = a.guidance ? ` Vary: ${a.guidance}.` : "";
        let req: ImageRequest;
        if (a.image_id && svc.store.get(a.image_id)?.conversationUrl) {
          req = { mode: "refine", prompt: `Create a distinct variation of this image with a different composition.${guidance}`, conversation: a.image_id, count, aspectRatio: a.aspect_ratio, parentImageId: a.image_id, useDefaultProfiles: false };
        } else {
          const images = a.images ?? (a.image_id ? [a.image_id] : []);
          if (!images.length) throw new UserFacingError("Pass image_id or images.", "INVALID_INPUT");
          req = { mode: "edit", prompt: `Create a distinct variation of this image that keeps its subject and style but changes the composition.${guidance}`, images, count, aspectRatio: a.aspect_ratio, parentImageId: a.image_id, useDefaultProfiles: false };
        }
        return await runJob(req, a.wait, extra as never);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Status and result of an image job. wait_seconds blocks until the job finishes or the time passes.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z.number().int().min(0).max(1800).optional().describe(`Seconds to wait for completion (default ${Math.min(cfg.syncWaitSec, 120)}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const wait = (a.wait_seconds ?? Math.min(cfg.syncWaitSec, 120)) * 1000;
      const job = await svc.queue.wait(a.job_id, wait);
      if (!job) return fail(new UserFacingError(`Job ${a.job_id} not found (jobs are kept in memory until restart).`, "NOT_FOUND"));
      return jobResult(job);
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description: "Recent image jobs with their status.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => ({ content: [text({ queue: svc.queue.stats(), jobs: svc.queue.list(a.limit ?? 20).map((j) => ({ ...jobView(j), result: undefined, images: j.result?.images.map((i) => i.id) })) })] }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel job",
      description: "Cancel a queued or running image job.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const job = svc.queue.cancel(a.job_id);
      if (!job) return fail(new UserFacingError(`Job ${a.job_id} not found.`, "NOT_FOUND"));
      return { content: [text({ job_id: job.id, status: job.status, note: job.status === "running" ? "Cancellation requested; the generation is being stopped." : undefined })] };
    },
  );

  server.registerTool(
    "list_images",
    {
      title: "List images",
      description: "Browse the image library, newest first. Filter by prompt text, conversation or tag.",
      inputSchema: {
        query: z.string().optional(),
        conversation_id: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const items = svc.store.list({ query: a.query, conversationId: a.conversation_id, tag: a.tag, limit: a.limit ?? 20 });
      return { content: [text({ total: svc.store.stats().images, images: items.map((r) => ({ ...describeImage(r), prompt: r.prompt.slice(0, 300) })) })] };
    },
  );

  server.registerTool(
    "get_image",
    {
      title: "Get image",
      description: "Return a stored image (inline) with its metadata.",
      inputSchema: { image_id: z.string(), include_prompt: z.boolean().optional().describe("Also return the exact prompt sent to ChatGPT.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const rec = svc.store.get(a.image_id);
      if (!rec) return fail(new UserFacingError(`Image ${a.image_id} not found.`, "NOT_FOUND"));
      return {
        content: [
          text({ ...describeImage(rec), prompt: rec.prompt, final_prompt: a.include_prompt ? rec.finalPrompt : undefined, conversation_url: rec.conversationUrl }),
          { type: "image", data: svc.store.readBytes(rec).toString("base64"), mimeType: rec.mimeType },
        ],
      };
    },
  );

  server.registerTool(
    "tag_image",
    {
      title: "Tag image",
      description: "Add tags to a library image so it can be found later (e.g. 'approved', 'hero').",
      inputSchema: { image_id: z.string(), tags: z.array(z.string().min(1).max(40)).min(1).max(20) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const rec = svc.store.tag(a.image_id, a.tags);
      return rec ? { content: [text(describeImage(rec))] } : fail(new UserFacingError(`Image ${a.image_id} not found.`, "NOT_FOUND"));
    },
  );

  server.registerTool(
    "delete_image",
    {
      title: "Delete image",
      description: "Delete an image from the server's library (it stays in the ChatGPT conversation).",
      inputSchema: { image_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => ({ content: [text({ image_id: a.image_id, deleted: svc.store.delete(a.image_id) })] }),
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "ChatGPT conversations this server has created images in, newest first. Use their ids with refine_image or generate_image(conversation).",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => ({
      content: [text(svc.store.conversations(a.limit ?? 20).map((c) => ({ conversation_id: c.id, url: c.url, title: c.title, updated_at: c.updatedAt, image_ids: c.imageIds.slice(-10) })))],
    }),
  );

  server.registerTool(
    "save_profile",
    {
      title: "Save character or style profile",
      description:
        "Save a reusable character (consistent person, mascot, product) or style profile. Reference image ids are uploaded with every request that uses the profile. make_default applies it automatically.",
      inputSchema: {
        name: z.string().min(1).max(60),
        kind: z.enum(["character", "style"]),
        description: z.string().min(1).max(4000),
        reference_image_ids: z.array(z.string()).max(4).optional(),
        make_default: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        for (const id of a.reference_image_ids ?? []) if (!svc.store.get(id)) throw new UserFacingError(`Image ${id} not found.`, "NOT_FOUND");
        const p = svc.profiles.upsert({ name: a.name, kind: a.kind, description: a.description, referenceImageIds: a.reference_image_ids ?? [] }, a.make_default);
        return { content: [text({ saved: p, defaults: svc.profiles.defaults() })] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_profiles",
    {
      title: "List profiles",
      description: "Saved character and style profiles, and which are defaults.",
      inputSchema: { kind: z.enum(["character", "style"]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => ({ content: [text({ defaults: svc.profiles.defaults(), profiles: svc.profiles.list(a.kind) })] }),
  );

  server.registerTool(
    "delete_profile",
    {
      title: "Delete profile",
      description: "Delete a saved profile, or only clear it as the default with clear_default_only.",
      inputSchema: { name: z.string(), kind: z.enum(["character", "style"]).optional(), clear_default_only: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const p = svc.profiles.get(a.name, a.kind);
      if (!p) return fail(new UserFacingError(`Profile ${a.name} not found.`, "NOT_FOUND"));
      if (a.clear_default_only) {
        if (svc.profiles.defaults()[p.kind] === p.name) svc.profiles.setDefault(p.kind, null);
        return { content: [text({ defaults: svc.profiles.defaults() })] };
      }
      return { content: [text({ deleted: svc.profiles.remove(p.name, p.kind) })] };
    },
  );

  server.registerTool(
    "list_style_presets",
    {
      title: "List style presets",
      description: "Built-in art-direction presets usable as style_preset.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [text(STYLE_PRESETS)] }),
  );

  server.registerTool(
    "check_session",
    {
      title: "Check ChatGPT session",
      description: "Open ChatGPT in the server's browser and report whether the configured login works. Optionally returns a screenshot (useful to debug challenges or UI changes).",
      inputSchema: { screenshot: z.boolean().optional(), last_error_screenshot: z.boolean().optional().describe("Return the screenshot saved at the last failure instead.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        if (a.last_error_screenshot) {
          const shot = svc.latestDiagnostic();
          return shot ? { content: [text("Latest failure screenshot"), { type: "image", data: shot.toString("base64"), mimeType: "image/png" }] } : { content: [text("No failure screenshots saved.")] };
        }
        const { status, screenshot } = await svc.checkSession(Boolean(a.screenshot));
        const content: CallToolResult["content"] = [text(status)];
        if (screenshot) content.push({ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" });
        return { content, isError: status.state !== "ready" };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_server_status",
    {
      title: "Server status",
      description: "Queue, storage and configuration summary (no browser access).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        text({
          version: SERVER_VERSION,
          queue: svc.queue.stats(),
          library: svc.store.stats(),
          session_configured: svc.browser.hasConfiguredSession,
          limits: { max_images_per_job: cfg.maxImagesPerJob, max_input_images: cfg.maxInputImages, sync_wait_seconds: cfg.syncWaitSec, generation_timeout_seconds: cfg.generationTimeoutSec },
          return_mode: cfg.returnMode,
          retention_days: cfg.retentionDays,
        }),
      ],
    }),
  );

  server.registerResource(
    "library-image",
    new ResourceTemplate("image://{id}", {
      list: async () => ({
        resources: svc.store.list({ limit: 50 }).map((r) => ({ uri: `image://${r.id}`, name: r.id, mimeType: r.mimeType, description: r.prompt.slice(0, 200) })),
      }),
    }),
    { title: "Library image", description: "An image generated by this server", mimeType: "image/png" },
    async (uri, vars) => {
      const id = String(vars.id);
      const rec = svc.store.get(id);
      if (!rec) throw new Error(`Image ${id} not found`);
      return { contents: [{ uri: uri.href, mimeType: rec.mimeType, blob: svc.store.readBytes(rec).toString("base64") }] };
    },
  );

  server.registerPrompt(
    "image_brief",
    {
      title: "Image brief",
      description: "Turn a rough idea into a detailed image prompt, then generate it.",
      argsSchema: { idea: z.string(), purpose: z.string().optional() },
    },
    ({ idea, purpose }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Write a detailed image prompt for: "${idea}"${purpose ? ` (used for ${purpose})` : ""}. ` +
              "Cover subject, setting, composition, lighting, colour palette, lens/medium and mood in 3-5 sentences. Then call generate_image with it and a fitting aspect_ratio and style_preset.",
          },
        },
      ],
    }),
  );

  return server;
}
