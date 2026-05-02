/**
 * Single-slide generation. Two paths depending on the user's request:
 *
 *   1. formatOverride === "auto" (default)
 *      → Run a classifier on the prompt to pick image vs layout
 *      → If layout: return the layout content directly (one model call)
 *      → If image: refine the prompt, then call the image model (two model calls)
 *
 *   2. formatOverride !== "auto"
 *      → Skip classification entirely
 *      → Either generate the image directly, or generate content for the
 *        forced layout kind (one model call)
 *
 * The route layer in app/api/generate/route.ts is a thin adapter that maps
 * results from this module into HTTP responses.
 */

import { getClient, getImageModel, getTextModel } from "./client";
import {
  extractImage,
  extractText,
  type FormatOverride,
  type SlideLayout,
  stripFences
} from "./helpers";

/**
 * Default house style appendix for image generation. Mirrors the "editorial"
 * preset in lib/ai/themes.ts. Kept here as a re-export so callers that don't
 * care about themes (tests, smoke scripts, simple usage) get sensible
 * defaults without importing the theme system.
 *
 * Theme-aware callers should pass `styleAppendix` to override this — that's
 * how the theme picker and "Lock style from this slide" feature work.
 */
import { DEFAULT_THEME } from "./themes";
export const HOUSE_STYLE_APPENDIX = DEFAULT_THEME.imagePromptAppendix;

export type SlideResult =
  | { kind: "image"; imageData: string; text?: string; reasoning: string }
  | { kind: "layout"; layout: SlideLayout; reasoning: string };

export type SlideError = { error: string; status: 400 | 500 | 502 };

type Classification =
  | { type: "image"; reasoning?: string; imagePrompt: string }
  | { type: "layout"; reasoning?: string; layout: SlideLayout };

export function buildClassificationPrompt(prompt: string, variation: boolean): string {
  return `You are a presentation slide format router. You decide whether a slide should be rendered as an AI-generated image OR as a structured text layout.

CRITICAL: Strongly prefer LAYOUT over IMAGE. Image generation is only correct when the slide is genuinely about a visual, scene, or atmosphere. Any slide that contains words a reader needs to read must be a layout — image models cannot render legible body text.

Choose IMAGE only for:
- Hero/title slides explicitly described as "an image of X" or "a photo of Y"
- Atmospheric, emotional, or scenic content where the picture IS the message
- Abstract metaphors better shown than told (a single visual concept, not a list)

Choose LAYOUT for everything else, including:
- Anything with bullets, numbers, percentages, $, %, names, or enumerated items
- Agendas, roadmaps, comparisons, processes, team intros, quotes
- Any prompt that contains the words: "agenda", "metrics", "list", "roadmap", "comparison"

Concrete examples:
- "Three product pillars: speed, trust, simplicity" → grid layout (3 items)
- "Key metrics: 94% CSAT, $2B in loans, 50 states" → stats layout (3 stats)
- "Why customers love us" → bullets layout
- "Welcome to Acme Corp" → title layout
- "A dramatic photo of a sunset over the city" → image
- "Hero shot of a happy family in their new home" → image

COMPOUND PROMPTS: If the prompt mixes multiple content types (e.g. "pillars AND metrics"), pick the layout best suited to the FIRST or PRIMARY content. Do not default to image just because the prompt is rich.

${variation ? "VARIATION REQUEST: The user wants a noticeably different take. Switch the layout kind, change the framing, or move between image and layout if appropriate.\n" : ""}
Slide description: """
${prompt}
"""

Reply with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

IMAGE format:
{"type":"image","reasoning":"<one sentence why image>","imagePrompt":"<refined prompt optimized for image generation>"}

TITLE layout (big headline + optional subtitle, good for opening/section dividers):
{"type":"layout","reasoning":"<one sentence>","layout":{"kind":"title","headline":"<text>","subtitle":"<text>"}}

BULLETS layout (headline + 3-6 concise points, ideal for lists):
{"type":"layout","reasoning":"<one sentence>","layout":{"kind":"bullets","headline":"<text>","bullets":["<point>","<point>","<point>"]}}

GRID layout (headline + 2-4 cards with title+body, ideal for pillars/features/team):
{"type":"layout","reasoning":"<one sentence>","layout":{"kind":"grid","headline":"<text>","items":[{"title":"<text>","body":"<text>"}]}}

STATS layout (2-4 big metrics, ideal for numbers/percentages):
{"type":"layout","reasoning":"<one sentence>","layout":{"kind":"stats","headline":"<text>","stats":[{"value":"<number or %>","label":"<text>"}]}}`;
}

function buildOverridePrompt(
  prompt: string,
  override: Exclude<FormatOverride, "auto" | "image">
): string {
  const layoutDescriptions: Record<typeof override, string> = {
    title:
      'TITLE layout: {"kind":"title","headline":"<text>","subtitle":"<text>"}. Big headline + optional subtitle.',
    bullets:
      'BULLETS layout: {"kind":"bullets","headline":"<text>","bullets":["<3-6 points>"]}.',
    grid:
      'GRID layout: {"kind":"grid","headline":"<text>","items":[{"title":"<text>","body":"<text>"}]}. 2-4 items.',
    stats:
      'STATS layout: {"kind":"stats","headline":"<text>","stats":[{"value":"<text>","label":"<text>"}]}. 2-4 stats.'
  };

  return `Generate slide content for the description below as a ${override.toUpperCase()} layout.

${layoutDescriptions[override]}

Slide description: """
${prompt}
"""

Reply with valid JSON only. No markdown fences. Your response must start with { and end with }.

Wrap the layout in: {"type":"layout","reasoning":"<one sentence>","layout":{...}}`;
}

export type GenerateSlideInput = {
  prompt: string;
  variation?: boolean;
  formatOverride?: FormatOverride;
  /** Optional override for the image-prompt appendix. When the deck has a
   * theme picked or a "locked" style extracted from a previous slide, the
   * client passes that theme's appendix here so all images in the deck stay
   * visually coherent. Defaults to HOUSE_STYLE_APPENDIX (editorial). */
  styleAppendix?: string;
};

/**
 * Generates either an image or a structured layout for a single slide.
 * Throws on missing API key (caught by the route adapter).
 * Returns either a SlideResult (success) or a SlideError (controlled failure).
 */
export async function generateSlide(input: GenerateSlideInput): Promise<SlideResult | SlideError> {
  const prompt = input.prompt?.trim();
  const variation = input.variation ?? false;
  const formatOverride: FormatOverride = input.formatOverride ?? "auto";
  const styleAppendix = input.styleAppendix?.trim() || HOUSE_STYLE_APPENDIX;

  if (!prompt) {
    return { error: "Prompt is required.", status: 400 };
  }

  const client = getClient();
  const textModel = getTextModel();
  const imageModel = getImageModel();

  // Hard override: image. Skip classification, go straight to image model.
  if (formatOverride === "image") {
    const variationLead =
      variation ?
        `VARIATION REQUEST: Produce a noticeably different visual treatment — alternate composition, crop, focal emphasis, or negative-space balance while preserving the subject. Avoid repeating a generic template composition.\n\n`
      : "";
    const effectivePrompt = `${variationLead}${prompt}\n\n${styleAppendix}`;
    const imageResponse = await client.models.generateContent({
      model: imageModel,
      contents: effectivePrompt,
      config: { responseModalities: ["TEXT", "IMAGE"] }
    });
    return parseImageResponse(imageResponse, "user requested image");
  }

  // Hard override: specific layout kind. Skip classification, ask for that layout.
  if (formatOverride !== "auto") {
    const layoutResponse = await client.models.generateContent({
      model: textModel,
      contents: buildOverridePrompt(prompt, formatOverride),
      config: { responseMimeType: "application/json" }
    });

    const rawText = extractText(layoutResponse);
    try {
      const parsed = JSON.parse(stripFences(rawText)) as Classification;
      if (parsed.type === "layout") {
        return {
          kind: "layout",
          layout: parsed.layout,
          reasoning: parsed.reasoning ?? `user forced ${formatOverride}`
        };
      }
    } catch {
      // fall through to error
    }
    return {
      error: `Could not generate ${formatOverride} layout. Raw model output: ${rawText.slice(0, 200)}`,
      status: 502
    };
  }

  // Auto path: classify first, then dispatch.
  let classification: Classification;
  let classifierRawOutput = "";

  try {
    const classificationResponse = await client.models.generateContent({
      model: textModel,
      contents: buildClassificationPrompt(prompt, variation),
      config: { responseMimeType: "application/json" }
    });
    classifierRawOutput = extractText(classificationResponse);
    classification = JSON.parse(stripFences(classifierRawOutput)) as Classification;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown classifier error";
    return {
      error: `Classifier failed: ${detail}. Raw output: ${classifierRawOutput.slice(0, 200) || "(empty)"}`,
      status: 502
    };
  }

  if (classification.type === "layout") {
    return {
      kind: "layout",
      layout: classification.layout,
      reasoning: classification.reasoning ?? "classified as layout"
    };
  }

  const effectivePrompt = `${classification.imagePrompt}\n\n${styleAppendix}`;
  const imageResponse = await client.models.generateContent({
    model: imageModel,
    contents: effectivePrompt,
    config: { responseModalities: ["TEXT", "IMAGE"] }
  });
  return parseImageResponse(imageResponse, classification.reasoning ?? "classified as image");
}

function parseImageResponse(
  imageResponse: { candidates?: unknown },
  reasoning: string
): SlideResult | SlideError {
  const image = extractImage(imageResponse);
  const text = extractText(imageResponse).trim();

  if (!image) {
    return {
      error: text || "The model answered, but it did not send an image back.",
      status: 502
    };
  }

  return {
    kind: "image",
    imageData: `data:${image.mimeType};base64,${image.data}`,
    text: text || undefined,
    reasoning
  };
}
