/**
 * Pure prompt builders for "revise this slide with a natural-language instruction".
 * Kept separate from generate-slide.ts so tests can lock the contract down.
 */

import type { SlideLayout } from "./helpers";

export function mergeBriefWithEditRequest(brief: string, instruction: string): string {
  const b = brief.trim();
  const i = instruction.trim();
  if (!b) return `User edit / generation request:\n"""${i}"""`;
  return `Original slide brief:\n"""${b}"""\n\nUser edit request:\n"""${i}"""`;
}

function indexHintForLayout(layout: SlideLayout): string {
  switch (layout.kind) {
    case "bullets":
      return `Bullets are 1-indexed when the user says "first bullet", "fourth bullet", etc.\nCurrent bullets:\n${layout.bullets.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`;
    case "grid":
      return `Grid cards are 1-indexed.\nCurrent cards:\n${layout.items.map((it, i) => `  ${i + 1}. ${it.title} — ${it.body}`).join("\n")}`;
    case "stats":
      return `Stats are 1-indexed.\nCurrent stats:\n${layout.stats.map((s, i) => `  ${i + 1}. ${s.value} — ${s.label}`).join("\n")}`;
    case "title":
      return "Title slide fields: headline, optional subtitle.";
    default:
      return "";
  }
}

/**
 * Text-model prompt: must return the same JSON wrapper + layout kind as normal generation.
 */
export function buildLayoutRevisionPrompt(params: {
  layout: SlideLayout;
  slideTitle: string;
  brief: string;
  instruction: string;
}): string {
  const { layout, slideTitle, brief, instruction } = params;
  const json = JSON.stringify(layout, null, 2);
  const indexHint = indexHintForLayout(layout);

  return `You revise an existing presentation slide that is rendered as STRUCTURED TEXT (not a bitmap).

Rules:
• Apply ONLY what the user asked. When the change is narrow (e.g. reword one bullet), leave every other string identical character-for-character unless a tiny grammar fix is unavoidable.
• Keep layout kind "${layout.kind}" — do not switch to image or another layout kind.
• Preserve the same number of items in each array (bullets, grid items, stats) unless the user explicitly asks to add, remove, or reorder items.
• If the user asks to regenerate the whole slide broadly, you may rewrite fields more freely while keeping the same layout kind and similar density.

Slide label: ${slideTitle.trim() || "(untitled)"}

Original slide brief (intent):
"""
${brief.trim() || "(none)"}
"""

Current layout JSON (source of truth — ground your edits here):
${json}

${indexHint}

User edit request:
"""
${instruction}
"""

Reply with valid JSON only. No markdown fences. No prose. Your response must start with { and end with }.

Return exactly this shape (replace inner layout with the full updated layout object of kind "${layout.kind}"):
{"type":"layout","reasoning":"<one sentence>","layout":{...}}`;
}

/**
 * User text that accompanies an inline image part for image-model revision.
 */
export function buildImageRevisionUserText(params: {
  slideTitle: string;
  brief: string;
  instruction: string;
  styleAppendix: string;
}): string {
  const brief = params.brief.trim() || "(none — infer from the reference image)";
  return `You are revising an existing 16:9 presentation slide image. Another part of this message is the CURRENT slide image — treat it as the starting frame.

Slide label: ${params.slideTitle.trim() || "(untitled)"}

Original generation brief:
"""
${brief}
"""

User edit request — follow this as precisely as possible; when it names a specific region or element, change only that unless they ask for a full redo:
"""
${params.instruction}
"""

Output one updated wide presentation slide image. For narrow edits, preserve composition, palette, and typography; for "start over" or "regenerate"-style asks, you may redesign.

Visual style guide:
${params.styleAppendix}`;
}
