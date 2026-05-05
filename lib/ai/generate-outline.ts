/**
 * Deck-from-brief outline generator. Takes a paragraph brief and returns
 * a structured deck outline — title, slides with names, prompts, suggested
 * formats, and speaker notes.
 */

import { getClient, getTextModel } from "./client";
import { extractText, normalizeFormat, parseModelJson, type FormatOverride } from "./helpers";

export type OutlineSlide = {
  name: string;
  prompt: string;
  suggestedFormat: FormatOverride;
  notes: string;
};

export type DeckOutline = {
  deckTitle: string;
  slides: OutlineSlide[];
};

export type OutlineError = { error: string; status: 400 | 500 | 502 };

export type GenerateOutlineInput = {
  brief: string;
  slideCount?: number;
};

export function buildOutlinePrompt(brief: string, slideCount: number | undefined): string {
  const countInstruction = slideCount
    ? `Generate exactly ${slideCount} slides.`
    : `Decide the right number of slides (typically 5-10). Lean toward fewer, tighter slides over more, longer ones.`;

  return `You are an expert presentation strategist. Given a brief, design a complete slide deck outline.

${countInstruction}

For each slide, provide:
- "name": a short slide title (3-6 words)
- "prompt": a detailed instruction for what should be on the slide. This will be passed to a slide generator that produces either an image or a structured layout. Include the actual content (specific bullet points, statistics, headlines), not vague descriptions.
- "suggestedFormat": one of "image" | "title" | "bullets" | "grid" | "stats" | "auto"
  - "image" — atmospheric/hero/scenic slides where the picture IS the message (opening, closing, emotional moments)
  - "title" — big section dividers or opening name slides
  - "bullets" — lists of points, agendas, key takeaways, sequential steps
  - "grid" — 2-4 peer concepts (pillars, features, team, comparison cards)
  - "stats" — 2-4 quantitative metrics with units (%, $, counts)
  - "auto" — only if you genuinely cannot decide
- "notes": 1-2 sentences of speaker notes — what the presenter should say, not what's on the slide

DECK STRUCTURE GUIDELINES:
- Open with a strong title or hero image slide.
- Close with a memorable ask, summary, or call to action.
- Vary formats — a deck of all-bullets or all-images is bad. Aim for visual rhythm.
- Match format to content. Do NOT default to "image" for content slides — image models cannot render legible body text.
- Speaker notes should add color the slide content doesn't already convey.

Brief: """
${brief}
"""

Reply with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

{
  "deckTitle": "<short deck title>",
  "slides": [
    {
      "name": "<slide title>",
      "prompt": "<detailed slide content + format direction>",
      "suggestedFormat": "<format>",
      "notes": "<speaker notes>"
    }
  ]
}`;
}

function isValidOutline(value: unknown): value is DeckOutline {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.deckTitle !== "string") return false;
  if (!Array.isArray(v.slides) || v.slides.length === 0) return false;
  return v.slides.every((s) => {
    if (!s || typeof s !== "object") return false;
    const slide = s as Record<string, unknown>;
    return typeof slide.name === "string" && typeof slide.prompt === "string";
  });
}

export async function generateOutline(
  input: GenerateOutlineInput
): Promise<DeckOutline | OutlineError> {
  const brief = input.brief?.trim();
  const slideCount =
    typeof input.slideCount === "number" && input.slideCount > 0 && input.slideCount <= 20
      ? Math.floor(input.slideCount)
      : undefined;

  if (!brief) {
    return { error: "Brief is required.", status: 400 };
  }

  if (brief.length < 10) {
    return { error: "Brief is too short — give the AI something to work with.", status: 400 };
  }

  const client = getClient();
  const textModel = getTextModel();

  let rawOutput = "";
  let parsed: unknown = null;

  try {
    const response = await client.models.generateContent({
      model: textModel,
      contents: buildOutlinePrompt(brief, slideCount),
      config: { responseMimeType: "application/json" }
    });
    rawOutput = extractText(response);
    parsed = parseModelJson(rawOutput);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      error: `Outline generation failed: ${detail}. Raw output: ${rawOutput.slice(0, 300) || "(empty)"}`,
      status: 502
    };
  }

  if (!isValidOutline(parsed)) {
    return {
      error: `Outline shape invalid. Raw output: ${rawOutput.slice(0, 300)}`,
      status: 502
    };
  }

  return {
    deckTitle: parsed.deckTitle,
    slides: parsed.slides.map((s) => ({
      name: s.name,
      prompt: s.prompt,
      suggestedFormat: normalizeFormat((s as Record<string, unknown>).suggestedFormat),
      notes:
        typeof (s as Record<string, unknown>).notes === "string"
          ? ((s as Record<string, unknown>).notes as string)
          : ""
    }))
  };
}
