import fs from "node:fs";
import path from "node:path";

export type ProfileKind = "character" | "style";

export interface Profile {
  name: string;
  kind: ProfileKind;
  description: string;
  /** Library image ids uploaded as visual references whenever the profile is used. */
  referenceImageIds: string[];
  updatedAt: string;
}

interface ProfilesFile {
  profiles: Profile[];
  defaults: { character?: string; style?: string };
}

/** Built-in style presets: short, prompt-ready art directions. */
export const STYLE_PRESETS: Record<string, string> = {
  photorealistic: "Photorealistic photograph, natural lighting, accurate materials, shallow depth of field, shot on a full-frame camera.",
  cinematic: "Cinematic film still, anamorphic lens, dramatic directional lighting, rich color grading, subtle film grain.",
  "product-shot": "Clean commercial product photography, seamless studio backdrop, soft box lighting, crisp reflections, no text.",
  "flat-illustration": "Flat vector illustration, bold simple shapes, limited harmonious palette, clean edges, no gradients.",
  "3d-render": "High-quality 3D render, soft global illumination, physically based materials, studio lighting.",
  isometric: "Isometric 3D illustration, 30-degree angle, clean geometry, soft shadows, vibrant but balanced colors.",
  anime: "Anime illustration, clean line art, cel shading, expressive characters, vivid backgrounds.",
  watercolor: "Watercolor painting, soft washes, visible paper texture, gentle color bleeding.",
  "oil-painting": "Classical oil painting, visible brush strokes, rich pigments, chiaroscuro lighting.",
  "pixel-art": "Pixel art, limited palette, crisp pixels, retro 16-bit game aesthetic.",
  "line-art": "Minimal black ink line art on white, consistent stroke weight, no shading.",
  logo: "Minimal modern logo mark, flat vector, simple geometric forms, centered on a plain background, no mockup.",
  icon: "App icon, centered symbol, simple bold shapes, soft gradient background, rounded-square safe area.",
  infographic: "Clean editorial infographic, clear hierarchy, legible labels, consistent iconography, generous whitespace.",
  sticker: "Die-cut sticker, thick white border, bold outlines, vibrant flat colors, isolated subject.",
  "ui-mockup": "High-fidelity UI mockup, modern design system, realistic content, crisp typography, device-agnostic.",
};

export class ProfileStore {
  private readonly file: string;
  private data: ProfilesFile;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "profiles.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8")) as ProfilesFile;
      this.data.profiles ??= [];
      this.data.defaults ??= {};
    } catch {
      this.data = { profiles: [], defaults: {} };
    }
  }

  private flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  list(kind?: ProfileKind): Profile[] {
    return this.data.profiles.filter((p) => !kind || p.kind === kind);
  }

  get(name: string, kind?: ProfileKind): Profile | undefined {
    const n = name.trim().toLowerCase();
    return this.data.profiles.find((p) => p.name.toLowerCase() === n && (!kind || p.kind === kind));
  }

  upsert(p: Omit<Profile, "updatedAt">, makeDefault = false): Profile {
    const existing = this.get(p.name, p.kind);
    const rec: Profile = { ...p, updatedAt: new Date().toISOString() };
    if (existing) Object.assign(existing, rec);
    else this.data.profiles.push(rec);
    if (makeDefault) this.data.defaults[p.kind] = p.name;
    this.flush();
    return existing ?? rec;
  }

  remove(name: string, kind?: ProfileKind): boolean {
    const before = this.data.profiles.length;
    const target = this.get(name, kind);
    if (!target) return false;
    this.data.profiles = this.data.profiles.filter((p) => p !== target);
    if (this.data.defaults[target.kind] === target.name) delete this.data.defaults[target.kind];
    this.flush();
    return this.data.profiles.length < before;
  }

  defaults(): ProfilesFile["defaults"] {
    return { ...this.data.defaults };
  }

  setDefault(kind: ProfileKind, name: string | null) {
    if (name) this.data.defaults[kind] = name;
    else delete this.data.defaults[kind];
    this.flush();
  }
}
