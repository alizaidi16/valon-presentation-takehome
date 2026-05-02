/**
 * Pure helpers for the live-generation feedback UI: elapsed-time calc and
 * context-aware "what's happening" hints. Extracted from app/page.tsx so they
 * can be unit-tested without React.
 *
 * Design principle: be honest, not magical. We don't fake server-side phase
 * events. We tell the user what to expect based on (kind, elapsed) and let
 * the actual timer keep climbing.
 */

import type { FormatOverride } from "@/lib/ai/helpers";

export function elapsedSeconds(startedAt: number | undefined, now: number): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export type WorkingHintInput = {
  /** What the user requested. "image", "auto", or undefined → image-path. */
  suggestedFormat?: FormatOverride;
  /** Seconds since work started. */
  elapsed: number;
};

/**
 * Returns the user-facing message for a slide that's currently working.
 * Layout slides are quick (one text-model call); image slides take longer
 * (classifier + image model). Messaging is calibrated to honest expectations
 * so users don't get bored or confused mid-wait.
 */
export function workingHint(input: WorkingHintInput): string {
  const { suggestedFormat, elapsed } = input;
  const isImage =
    suggestedFormat === "image" || suggestedFormat === "auto" || !suggestedFormat;

  if (!isImage) {
    if (elapsed < 3) return "Drafting layout content...";
    return "Wrapping up...";
  }

  if (elapsed < 3) return "Classifying the prompt...";
  if (elapsed < 10) return "Generating image (typically 8-15s)...";
  if (elapsed < 18) return "Almost there...";
  return "Image generation is taking longer than usual...";
}
