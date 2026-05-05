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
 *   3. Optional `editInstruction` + slide context (`existingLayout`, `referenceImageData`)
 *      → Runs a targeted layout or image revision before falling back to
 *        re-generation with merged brief + instruction.
 *
 * The route layer in app/api/generate/route.ts is a thin adapter that maps
 * results from this module into HTTP responses.
 */

import { getClient, getImageModel, getTextModel } from "./client";
import {
  buildImageRevisionUserText,
  buildLayoutRevisionPrompt,
  mergeBriefWithEditRequest
} from "./edit-slide-prompts";
import { isRetryableGeminiError, withGeminiRetries } from "./gemini-retry";
import {
  extractImage,
  extractText,
  type FormatOverride,
  parseDataUrl,
  parseModelJson,
  type SlideLayout
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
  return `You are a presentation slide format router. Pick AI-generated IMAGE vs structured text LAYOUT.

IMAGE vs TITLE LAYOUT — critical distinction:
• The title layout (kind:title) renders headline + optional subtitle on a flat/paper background ONLY. No photograph or illustrated scene appears — it cannot satisfy wording like "single hero image", "cover shot", or "splashed photography behind the headline".
• If the user asks for ANY photographic or illustrated visuals — hero image, cover visual, keynote photo, splash, illustration, billboard, magazine-style cover, backdrop behind headline, panorama, cinematic or atmospheric opener — classify as IMAGE. Put the refined scene + headline typography intent in imagePrompt.
• Treat "editorial title slide … plus a hero / cover / photographic element" as IMAGE always. Routing that to title layout is an error.

Choose IMAGE when:
• A scene, metaphor, illustration, atmospheric shot, photographic subject, hero frame, infographics rendered as imagery, etc. dominates the slide
• Keynote-style opens where a visual carries the opener and headline text stays headline-grade only

Choose LAYOUT when:
• Readable body copy dominates — bullets, lists, agendas, timelines, grids, stats with labels, comparisons, numbered takeaways — image models cannot render sharp multi-block text.
• Truly text-only openers — headline + subtitle, no depiction requested (e.g. "Welcome to Acme Corp" alone).

HIGH-SIGNAL LAYOUT TRIGGER WORDS ("agenda", "metrics", "list", "roadmap", "comparison") apply when those words describe CORE slide content — not stray adjectives beside an otherwise-visual hero opener.

Concrete examples:
• "Three product pillars: speed, trust, simplicity" → grid layout (3 items)
• "Key metrics: 94% CSAT, $2B in loans, 50 states" → stats layout (3 stats)
• "Why customers love us" → bullets layout
• "Welcome to Acme Corp" → title layout (no visual requested)
• "An editorial title slide for a mortgage startup, with a single hero image and a confident headline" → IMAGE (explicit hero imagery + headline)
• "A dramatic photo of a sunset over the city" → image
• "Hero shot of a happy family in their new home" → image

COMPOUND PROMPTS: Pick the modality that fulfills the MAIN user intent — hero/visual + headline = IMAGE first; pillars + metrics mashed together → choose the strongest layout shape for the enumerated content.

${variation ? "VARIATION REQUEST: The user wants a noticeably different take. Switch the layout kind, change the framing, or move between image and layout if appropriate.\n" : ""}
Slide description: """
${prompt}
"""

Reply with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

IMAGE format:
{"type":"image","reasoning":"<one sentence why image>","imagePrompt":"<refined prompt optimized for image generation>"}

TITLE layout — words on solid background ONLY; never when the slide brief asks for a hero photo / illustrated scene):
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
  /** Natural-language edit — combined with slide context for targeted revisions. */
  editInstruction?: string;
  /** Current layout JSON when revising a layout slide. */
  existingLayout?: SlideLayout;
  /** Current slide image as a data URL (from the client canvas). */
  referenceImageData?: string;
  /** Deck list title for the slide — extra grounding for edits. */
  slideTitle?: string;
};

/**
 * Generates either an image or a structured layout for a single slide.
 * Throws on missing API key (caught by the route adapter).
 * Returns either a SlideResult (success) or a SlideError (controlled failure).
 */
export async function generateSlide(input: GenerateSlideInput): Promise<SlideResult | SlideError> {
  const editInstr = input.editInstruction?.trim();
  if (editInstr) {
    const specialized = await tryInstructionBasedRevision({
      ...input,
      editInstruction: editInstr
    });
    if (specialized) return specialized;

    const mergedPrompt = mergeBriefWithEditRequest(input.prompt ?? "", editInstr);
    return generateSlideFresh({ ...input, prompt: mergedPrompt, editInstruction: undefined });
  }

  const promptTrim = input.prompt?.trim();
  if (!promptTrim) {
    return { error: "Prompt is required.", status: 400 };
  }

  return generateSlideFresh({ ...input, prompt: promptTrim, editInstruction: undefined });
}

/**
 * Existing generate flow — no instruction-based branching (caller merges prompt if needed).
 */
async function generateSlideFresh(input: GenerateSlideInput): Promise<SlideResult | SlideError> {
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
    const imageResponse = await withGeminiRetries(() =>
      client.models.generateContent({
        model: imageModel,
        contents: effectivePrompt,
        config: { responseModalities: ["TEXT", "IMAGE"] }
      })
    );
    return parseImageResponse(imageResponse, "user requested image");
  }

  // Hard override: specific layout kind. Skip classification, ask for that layout.
  if (formatOverride !== "auto") {
    const layoutResponse = await withGeminiRetries(() =>
      client.models.generateContent({
        model: textModel,
        contents: buildOverridePrompt(prompt, formatOverride),
        config: { responseMimeType: "application/json" }
      })
    );

    const rawText = extractText(layoutResponse);
    try {
      const parsed = parseModelJson(rawText) as Classification;
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
    const classificationResponse = await withGeminiRetries(() =>
      client.models.generateContent({
        model: textModel,
        contents: buildClassificationPrompt(prompt, variation),
        config: { responseMimeType: "application/json" }
      })
    );
    classifierRawOutput = extractText(classificationResponse);
    classification = parseModelJson(classifierRawOutput) as Classification;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown classifier error";
    const overloadHint = isRetryableGeminiError(err)
      ? " Demand spikes are usually short — click Cook again in a moment."
      : "";
    return {
      error: `Classifier failed: ${detail}.${overloadHint} Raw output: ${classifierRawOutput.slice(0, 200) || "(empty)"}`,
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
  const imageResponse = await withGeminiRetries(() =>
    client.models.generateContent({
      model: imageModel,
      contents: effectivePrompt,
      config: { responseModalities: ["TEXT", "IMAGE"] }
    })
  );
  return parseImageResponse(imageResponse, classification.reasoning ?? "classified as image");
}

async function tryInstructionBasedRevision(
  input: GenerateSlideInput & { editInstruction: string }
): Promise<SlideResult | SlideError | null> {
  const formatOverride = input.formatOverride ?? "auto";
  const styleAppendix = input.styleAppendix?.trim() || HOUSE_STYLE_APPENDIX;
  const slideTitle = input.slideTitle ?? "";
  const brief = input.prompt ?? "";
  const instr = input.editInstruction;

  // 1) Layout revision — existing structured content is authoritative.
  if (input.existingLayout && formatOverride !== "image") {
    return runLayoutRevision({
      layout: input.existingLayout,
      slideTitle,
      brief,
      instruction: instr
    });
  }

  // 2) Image revision — multimodal reference + instruction.
  const ref = input.referenceImageData?.trim();
  if (ref && (formatOverride === "image" || formatOverride === "auto")) {
    const parsed = parseDataUrl(ref);
    if (parsed) {
      return runImageRevision({
        brief,
        slideTitle,
        instruction: instr,
        styleAppendix,
        mimeType: parsed.mimeType,
        data: parsed.data
      });
    }
  }

  return null;
}

async function runLayoutRevision(params: {
  layout: SlideLayout;
  slideTitle: string;
  brief: string;
  instruction: string;
}): Promise<SlideResult | SlideError> {
  const client = getClient();
  const textModel = getTextModel();
  const revisionPrompt = buildLayoutRevisionPrompt({
    layout: params.layout,
    slideTitle: params.slideTitle,
    brief: params.brief,
    instruction: params.instruction
  });

  const layoutResponse = await withGeminiRetries(() =>
    client.models.generateContent({
      model: textModel,
      contents: revisionPrompt,
      config: { responseMimeType: "application/json" }
    })
  );

  const rawText = extractText(layoutResponse);
  try {
    const parsed = parseModelJson(rawText) as Classification;
    if (parsed.type !== "layout" || !parsed.layout) {
      return {
        error: `Layout edit did not return layout JSON. Raw: ${rawText.slice(0, 200)}`,
        status: 502
      };
    }
    if (parsed.layout.kind !== params.layout.kind) {
      return {
        error: `Model changed layout kind (expected ${params.layout.kind}, got ${parsed.layout.kind}). Try rephrasing the edit.`,
        status: 502
      };
    }
    return {
      kind: "layout",
      layout: parsed.layout,
      reasoning: parsed.reasoning ?? "layout revision"
    };
  } catch {
    return {
      error: `Could not parse layout edit. Raw: ${rawText.slice(0, 200)}`,
      status: 502
    };
  }
}

async function runImageRevision(params: {
  brief: string;
  slideTitle: string;
  instruction: string;
  styleAppendix: string;
  mimeType: string;
  data: string;
}): Promise<SlideResult | SlideError> {
  const client = getClient();
  const imageModel = getImageModel();
  const userText = buildImageRevisionUserText({
    slideTitle: params.slideTitle,
    brief: params.brief,
    instruction: params.instruction,
    styleAppendix: params.styleAppendix
  });

  const imageResponse = await withGeminiRetries(() =>
    client.models.generateContent({
      model: imageModel,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: params.mimeType, data: params.data } },
            { text: userText }
          ]
        }
      ],
      config: { responseModalities: ["TEXT", "IMAGE"] }
    })
  );

  return parseImageResponse(imageResponse, "image revision");
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
