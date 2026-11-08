export const ASPECT_RATIOS = {
  "1:1": "square 1:1",
  "3:2": "landscape 3:2",
  "2:3": "portrait 2:3",
  "4:3": "landscape 4:3",
  "3:4": "portrait 3:4",
  "16:9": "wide landscape 16:9",
  "9:16": "tall portrait 9:16 (phone wallpaper / story)",
  "21:9": "ultra-wide cinematic 21:9",
} as const;
export type AspectRatio = keyof typeof ASPECT_RATIOS;

export interface PromptParts {
  prompt: string;
  mode: "generate" | "edit" | "refine" | "variation";
  aspectRatio?: AspectRatio;
  style?: string;
  character?: string;
  negative?: string;
  textInImage?: string;
  transparentBackground?: boolean;
  referenceCount?: number;
  /** Send the prompt untouched (no wrapper sentences). */
  raw?: boolean;
}

/**
 * ChatGPT decides on its own whether to answer with text or an image. The wrapper makes
 * the intent explicit and pins down the parameters the web UI has no controls for.
 */
export function buildPrompt(p: PromptParts): string {
  const prompt = p.prompt.trim();
  if (p.raw) return prompt;
  const lines: string[] = [];
  switch (p.mode) {
    case "generate":
      lines.push("Create an image. Generate it directly without asking follow-up questions.");
      break;
    case "edit":
      lines.push(
        p.referenceCount && p.referenceCount > 1
          ? `Edit the first attached image using the other ${p.referenceCount - 1} attached image(s) as reference. Generate the edited image directly.`
          : "Edit the attached image. Keep everything that the instruction does not mention unchanged. Generate the edited image directly.",
      );
      break;
    case "refine":
      lines.push("Update the last image you generated in this conversation. Keep everything that the instruction does not mention unchanged. Generate the new image directly.");
      break;
    case "variation":
      lines.push("Create another distinct variation of the image request above, with a different composition. Generate it directly.");
      break;
  }
  if (p.mode !== "variation") lines.push("", p.mode === "generate" ? `Description: ${prompt}` : `Instruction: ${prompt}`);
  else if (prompt) lines.push("", `Variation guidance: ${prompt}`);

  const specs: string[] = [];
  if (p.aspectRatio) specs.push(`Aspect ratio: ${ASPECT_RATIOS[p.aspectRatio]}.`);
  if (p.character) specs.push(`Character (keep identity consistent): ${p.character.trim()}`);
  if (p.style) specs.push(`Art direction: ${p.style.trim()}`);
  if (p.textInImage) specs.push(`Render exactly this text in the image, spelled correctly: "${p.textInImage.trim()}"`);
  if (p.transparentBackground) specs.push("Use a transparent background (PNG with alpha), subject isolated.");
  if (p.negative) specs.push(`Avoid: ${p.negative.trim()}`);
  if (p.mode === "generate" && p.referenceCount) specs.push(`Use the ${p.referenceCount} attached image(s) as visual reference.`);
  if (specs.length) lines.push("", ...specs);
  return lines.join("\n").trim();
}
