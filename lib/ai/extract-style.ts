/**
 * Style DNA extractor. Takes a generated image (data URL) and asks a VLM to
 * describe its visual identity in a structured way: 3-color palette, mood
 * label, and a paragraph that can be appended to subsequent image-generation
 * prompts to keep the rest of the deck visually coherent.
 *
 * Returns shape compatible with lib/ai/themes.ts → buildLockedTheme.
 */

import type { Part } from "@google/genai";
import { getClient, getTextModel } from "./client";
import { extractText, parseModelJson } from "./helpers";
import { sanitizeHex } from "./themes";

export type StyleDNA = {
  palette: { paper: string; ink: string; accent: string };
  mood: string;
  imagePromptAppendix: string;
};

export type StyleDNAError = { error: string; status: 400 | 500 | 502 };

export type ExtractStyleInput = {
  /** Data URL: "data:image/png;base64,..." */
  imageData: string;
};

const EXTRACT_PROMPT = `You are a brand designer's eye. Look at this image and extract its visual identity so we can apply the same style to other slides in the same deck.

Respond with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

{
  "palette": {
    "paper": "<hex color of the background / dominant negative space, e.g. #fffaf0>",
    "ink": "<hex color of the main foreground / text / dark figure, e.g. #1f160f>",
    "accent": "<hex color of the secondary highlight / smaller pop element. If the image is monochrome, repeat ink.>"
  },
  "mood": "<one or two words: 'editorial', 'pitch deck', 'monochrome', 'noir', 'pastel', 'tech', etc.>",
  "imagePromptAppendix": "<5-7 lines describing the visual style in concrete prompt-ready terms. Cover: palette, composition, typography (if any text), mood, and what to AVOID. This text will be appended verbatim to future image-generation prompts to keep the deck coherent.>"
}

GUIDANCE:
- Hex must be 6-char "#rrggbb". Lowercase preferred.
- imagePromptAppendix is the meat — be specific. Example tone:
  "Editorial illustration aesthetic. Warm cream background (#fffaf0), deep ink foreground (#1f160f), terracotta accent (#b8553a). Generous negative space, single focal subject, no decorative clutter. Typography is clean modern sans-serif. Avoid gradients, shadows, 3D, stock-art clichés."
- Don't be poetic; be technical. The model reading this prompt later won't infer your intent — spell it out.`;

export async function extractStyle(
  input: ExtractStyleInput
): Promise<StyleDNA | StyleDNAError> {
  if (!input.imageData) {
    return { error: "imageData is required.", status: 400 };
  }

  const parsedImage = parseDataUrl(input.imageData);
  if (!parsedImage) {
    return { error: "imageData must be a base64 data URL.", status: 400 };
  }

  const client = getClient();
  const textModel = getTextModel();

  const parts: Part[] = [
    { inlineData: { mimeType: parsedImage.mimeType, data: parsedImage.data } },
    { text: EXTRACT_PROMPT }
  ];

  let rawOutput = "";
  let parsed: unknown = null;

  try {
    const response = await client.models.generateContent({
      model: textModel,
      contents: parts,
      config: { responseMimeType: "application/json" }
    });
    rawOutput = extractText(response);
    parsed = parseModelJson(rawOutput);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      error: `Style extraction failed: ${detail}. Raw output: ${rawOutput.slice(0, 200) || "(empty)"}`,
      status: 502
    };
  }

  return normalizeStyleDNA(parsed) ?? {
    error: `Style DNA shape invalid. Raw output: ${rawOutput.slice(0, 300)}`,
    status: 502
  };
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Coerce model output into a StyleDNA. We require a usable palette and an
 * appendix; mood defaults to "custom" if missing. Hex validation goes through
 * sanitizeHex so partially-malformed responses still produce something.
 */
export function normalizeStyleDNA(value: unknown): StyleDNA | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const paletteRaw = (v.palette ?? {}) as Record<string, unknown>;
  const paper = sanitizeHex(paletteRaw.paper);
  const ink = sanitizeHex(paletteRaw.ink);
  const accent = sanitizeHex(paletteRaw.accent) ?? ink;

  if (!paper || !ink || !accent) return null;

  const appendix =
    typeof v.imagePromptAppendix === "string" && v.imagePromptAppendix.trim().length > 20
      ? v.imagePromptAppendix.trim()
      : null;

  if (!appendix) return null;

  const mood = typeof v.mood === "string" && v.mood.trim() ? v.mood.trim() : "custom";

  return {
    palette: { paper, ink, accent },
    mood,
    imagePromptAppendix: appendix
  };
}
