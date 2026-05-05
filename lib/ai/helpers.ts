/**
 * Small utilities shared across AI calls — JSON cleanup, response parsing,
 * format validation. Keep this file dependency-free so it's trivially testable.
 */

export type FormatOverride = "auto" | "image" | "title" | "bullets" | "grid" | "stats";

export const VALID_FORMATS: FormatOverride[] = [
  "auto",
  "image",
  "title",
  "bullets",
  "grid",
  "stats"
];

export type TitleLayout = { kind: "title"; headline: string; subtitle?: string };
export type BulletsLayout = { kind: "bullets"; headline: string; bullets: string[] };
export type GridLayout = {
  kind: "grid";
  headline: string;
  items: Array<{ title: string; body: string }>;
};
export type StatsLayout = {
  kind: "stats";
  headline?: string;
  stats: Array<{ value: string; label: string }>;
};
export type SlideLayout = TitleLayout | BulletsLayout | GridLayout | StatsLayout;

/**
 * Strip markdown code fences from model output. Some Gemini and Claude variants
 * occasionally wrap JSON in ```json ... ``` despite explicit prompt instructions.
 */
export function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/**
 * Pull the first top-level `{ ... }` object from noisy model output.
 * Gemini sometimes appends prose or emits a second JSON blob after responseMimeType
 * did not constrain the stream strictly enough; plain JSON.parse then throws
 * "Unexpected non-whitespace character after JSON".
 */
export function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }

  return null;
}

/** Strip fences, isolate first JSON object, then parse — resilient to trailing junk. */
export function parseModelJson(text: string): unknown {
  const cleaned = stripFences(text.trim());
  const extracted = extractFirstJsonObject(cleaned);
  return JSON.parse(extracted ?? cleaned);
}

/**
 * Concatenate all text parts from a Gemini generateContent response.
 */
export function extractText(response: { candidates?: unknown }): string {
  const candidates = (response.candidates ?? []) as Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  return candidates
    .flatMap((c) => c.content?.parts ?? [])
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Coerce an unknown value into a valid FormatOverride, falling back to "auto".
 */
export function normalizeFormat(value: unknown): FormatOverride {
  if (typeof value === "string" && (VALID_FORMATS as string[]).includes(value)) {
    return value as FormatOverride;
  }
  return "auto";
}

/**
 * Pull the first inline image part out of a Gemini response.
 * Returns null if the response contains no image data.
 */
export function extractImage(response: {
  candidates?: unknown;
}): { mimeType: string; data: string } | null {
  const candidates = (response.candidates ?? []) as Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  const parts = candidates.flatMap((c) => c.content?.parts ?? []);
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data || !imagePart.inlineData.mimeType) {
    return null;
  }
  return {
    mimeType: imagePart.inlineData.mimeType,
    data: imagePart.inlineData.data
  };
}

/**
 * Parse a `data:...;base64,...` URL into mime + raw base64 payload (no data: prefix).
 * Returns null if the string is not a base64 data URL.
 */
export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const trimmed = dataUrl.trim();
  const m = trimmed.match(/^data:([^,]+),([\s\S]+)$/);
  if (!m) return null;
  const meta = m[1];
  const data = m[2].replace(/\s/g, "");
  if (!meta.toLowerCase().includes("base64")) return null;
  const mimeType = meta.split(";")[0]?.trim();
  if (!mimeType) return null;
  return { mimeType, data };
}
