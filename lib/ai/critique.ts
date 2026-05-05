/**
 * Slide critique. Sends a slide (prompt + content + optional rendered image)
 * to a text model and gets back structured feedback the UI can render as a
 * panel: an overall verdict, a few strengths, and a list of issues with
 * severity + suggested fix.
 *
 * Multimodal: when the slide is an image, we send the image bytes back to
 * the model as inlineData so it can actually look at the rendered output.
 * For layout slides we send the structured content as JSON.
 */

import type { Part } from "@google/genai";
import { getClient, getTextModel } from "./client";
import { extractText, type SlideLayout, parseModelJson } from "./helpers";

export type CritiqueSeverity = "high" | "medium" | "low";
export type CritiqueArea = "message" | "visual" | "structure" | "fit";
export type CritiqueOverall = "strong" | "good" | "needs-work" | "weak";

export type CritiqueIssue = {
  severity: CritiqueSeverity;
  area: CritiqueArea;
  message: string;
  suggestion: string;
};

export type Critique = {
  overall: CritiqueOverall;
  summary: string;
  strengths: string[];
  issues: CritiqueIssue[];
};

export type CritiqueError = { error: string; status: 400 | 500 | 502 };

export type CritiqueSlideInput = {
  /** The original prompt the user wrote for this slide. */
  prompt: string;
  /** Slide name, used for context in feedback. */
  name?: string;
  /** Speaker notes, if any. */
  notes?: string;
  /** Either "image" (uses imageData) or "layout" (uses layout). */
  kind: "image" | "layout";
  /** Data URL like "data:image/png;base64,..." — required when kind === "image". */
  imageData?: string;
  /** Structured layout content — required when kind === "layout". */
  layout?: SlideLayout;
};

const VALID_SEVERITY: CritiqueSeverity[] = ["high", "medium", "low"];
const VALID_AREA: CritiqueArea[] = ["message", "visual", "structure", "fit"];
const VALID_OVERALL: CritiqueOverall[] = ["strong", "good", "needs-work", "weak"];

export function buildCritiquePrompt(input: CritiqueSlideInput): string {
  const layoutBlock = input.layout
    ? `\n\nRendered layout (JSON):\n${JSON.stringify(input.layout, null, 2)}`
    : "";

  const noteBlock = input.notes ? `\n\nSpeaker notes: """${input.notes}"""` : "";

  const imageNote =
    input.kind === "image"
      ? "\n\nThe rendered image is attached. Critique the IMAGE you see, not just the prompt."
      : "";

  return `You are a senior presentation design coach. You give blunt, specific, actionable feedback — never vague platitudes.

Critique this single slide.

Slide name: """${input.name || "(untitled)"}"""
Prompt the user wrote: """${input.prompt}"""${layoutBlock}${noteBlock}${imageNote}

Respond with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

{
  "overall": "<strong | good | needs-work | weak>",
  "summary": "<one sentence verdict — what's the headline takeaway?>",
  "strengths": ["<1-3 short strings, each one specific thing that works>"],
  "issues": [
    {
      "severity": "<high | medium | low>",
      "area": "<message | visual | structure | fit>",
      "message": "<what's wrong, in one sentence>",
      "suggestion": "<a specific, concrete fix the user could apply>"
    }
  ]
}

GUIDANCE:
- Be specific. "Headline is weak" is useless. "Headline 'Our Approach' could be 'Cut reconciliation time 80%'" is useful.
- Severity high = a reviewer will notice immediately and it hurts the deck.
- Severity low = a polish-pass detail.
- Area message = what the slide says. visual = how it looks. structure = where it sits in the deck / how it's organized. fit = does this match the prompt's intent.
- Strengths are not required (use [] if there's nothing genuinely strong) but issues should always have at least one entry — no slide is perfect.
- Cap issues at 5. Pick the highest-leverage ones, don't dump everything.`;
}

export async function critiqueSlide(
  input: CritiqueSlideInput
): Promise<Critique | CritiqueError> {
  if (!input.prompt?.trim()) {
    return { error: "Prompt is required to critique a slide.", status: 400 };
  }

  if (input.kind === "image" && !input.imageData) {
    return { error: "imageData required for image-kind critique.", status: 400 };
  }

  if (input.kind === "layout" && !input.layout) {
    return { error: "layout required for layout-kind critique.", status: 400 };
  }

  const client = getClient();
  const textModel = getTextModel();

  // Build the contents array. For image slides, prepend the image part so the
  // model can actually see what it's critiquing.
  const promptText = buildCritiquePrompt(input);
  const parts: Part[] = [];

  if (input.kind === "image" && input.imageData) {
    const parsedImage = parseDataUrl(input.imageData);
    if (parsedImage) {
      parts.push({ inlineData: { mimeType: parsedImage.mimeType, data: parsedImage.data } });
    }
  }
  parts.push({ text: promptText });

  let rawOutput = "";
  let parsed: unknown = null;

  try {
    const response = await client.models.generateContent({
      model: textModel,
      contents: parts.length === 1 ? promptText : parts,
      config: { responseMimeType: "application/json" }
    });
    rawOutput = extractText(response);
    parsed = parseModelJson(rawOutput);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      error: `Critique failed: ${detail}. Raw output: ${rawOutput.slice(0, 200) || "(empty)"}`,
      status: 502
    };
  }

  const normalized = normalizeCritique(parsed);
  if (!normalized) {
    return {
      error: `Critique shape invalid. Raw output: ${rawOutput.slice(0, 300)}`,
      status: 502
    };
  }
  return normalized;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Coerce a model response into a valid Critique. We're permissive about
 * field-level invalidity (drop bad issues, default missing fields) but
 * strict about overall shape. Returns null if it can't be salvaged.
 */
export function normalizeCritique(value: unknown): Critique | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const overall = (VALID_OVERALL as string[]).includes(v.overall as string)
    ? (v.overall as CritiqueOverall)
    : "good";

  const summary = typeof v.summary === "string" ? v.summary : "";
  if (!summary) return null;

  const strengths = Array.isArray(v.strengths)
    ? (v.strengths as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  const rawIssues = Array.isArray(v.issues) ? (v.issues as unknown[]) : [];
  const issues: CritiqueIssue[] = rawIssues
    .map((i) => {
      if (!i || typeof i !== "object") return null;
      const issue = i as Record<string, unknown>;
      const severity = (VALID_SEVERITY as string[]).includes(issue.severity as string)
        ? (issue.severity as CritiqueSeverity)
        : "medium";
      const area = (VALID_AREA as string[]).includes(issue.area as string)
        ? (issue.area as CritiqueArea)
        : "message";
      const message = typeof issue.message === "string" ? issue.message : "";
      const suggestion = typeof issue.suggestion === "string" ? issue.suggestion : "";
      if (!message) return null;
      return { severity, area, message, suggestion };
    })
    .filter((i): i is CritiqueIssue => i !== null)
    .slice(0, 5);

  return { overall, summary, strengths: strengths.slice(0, 5), issues };
}
