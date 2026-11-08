/**
 * CSS selectors for the ChatGPT web UI. ChatGPT changes its DOM regularly, so every
 * group is a list of fallbacks, and the whole map can be overridden at runtime with
 * CHATGPT_SELECTORS_JSON (a JSON object with the same keys, values as string arrays).
 */
export interface Selectors {
  composer: string[];
  send: string[];
  stop: string[];
  fileInput: string[];
  attach: string[];
  newChat: string[];
  assistantTurn: string[];
  userTurn: string[];
  generatedImage: string[];
  uploadPending: string[];
  loginMarkers: string[];
}

export const DEFAULT_SELECTORS: Selectors = {
  composer: [
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "div[contenteditable='true'][role='textbox']",
    "div.ProseMirror[contenteditable='true']",
    "textarea[name='prompt-textarea']",
  ],
  send: [
    "[data-testid='send-button']",
    "button#composer-submit-button",
    "button[aria-label='Send prompt']",
    "button[aria-label='Send message']",
  ],
  stop: [
    "[data-testid='stop-button']",
    "button[aria-label='Stop streaming']",
    "button[aria-label*='Stop']",
  ],
  fileInput: ["input[type='file'][accept*='image']", "input[type='file']"],
  attach: [
    "[data-testid='composer-plus-btn']",
    "button[aria-label='Add photos and files']",
    "button[aria-label*='Attach']",
    "button[aria-label*='Upload']",
  ],
  newChat: [
    "[data-testid='create-new-chat-button']",
    "a[data-testid='new-chat-button']",
    "a[href='/'][aria-label*='New chat']",
    "button[aria-label='New chat']",
  ],
  assistantTurn: [
    "[data-message-author-role='assistant']",
    "article[data-testid^='conversation-turn']",
    "article",
  ],
  userTurn: ["[data-message-author-role='user']"],
  generatedImage: [
    "img[src*='/backend-api/estuary/content']",
    "img[src*='oaiusercontent.com']",
    "img[alt*='Generated image']",
    "main article img",
    "main img",
  ],
  uploadPending: ["[data-testid='file-upload-progress']", "[role='progressbar']", "circle[stroke-dasharray]"],
  loginMarkers: [
    "[data-testid='login-button']",
    "button[data-testid='signup-button']",
    "a[href*='auth/login']",
  ],
};

export function loadSelectors(overrideJson: string): Selectors {
  if (!overrideJson) return DEFAULT_SELECTORS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(overrideJson);
  } catch {
    throw new Error("CHATGPT_SELECTORS_JSON is not valid JSON");
  }
  const merged: Selectors = { ...DEFAULT_SELECTORS };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in DEFAULT_SELECTORS)) continue;
    const arr = Array.isArray(value) ? value : [value];
    const clean = arr.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (clean.length) (merged as unknown as Record<string, string[]>)[key] = clean;
  }
  return merged;
}

export const any = (list: string[]) => list.join(", ");
