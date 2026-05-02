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
