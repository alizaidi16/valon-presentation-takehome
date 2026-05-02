/**
 * Theme system. A Theme bundles together everything that controls the visual
 * identity of a deck: CSS custom properties for layout slides, hex values for
 * the PPTX exporter, an image-prompt appendix that shapes generated images,
 * and a font pairing.
 *
 * Why this lives in lib/ai/: themes are an input to the image generator
 * (via imagePromptAppendix). They're not a UI concern alone; they're a
 * lever the AI uses too.
 *
 * "Locked" themes (extracted via lib/ai/extract-style.ts from a generated
 * image) are constructed at runtime and follow the same Theme shape, so the
 * rest of the app doesn't need to know whether a theme is preset or extracted.
 */

export type ThemeId = "editorial" | "monochrome" | "pitch" | "locked";

export type Theme = {
  id: ThemeId;
  /** Human-readable label for the picker. */
  name: string;
  /** One-sentence description for tooltips/help. */
  blurb: string;
  /** CSS custom properties applied to <html> / overridden on the deck root. */
  cssVars: {
    bg: string;
    paper: string;
    ink: string;
    inkSoft: string;
    inkMuted: string;
    rule: string;
    ruleStrong: string;
    accent: string;
    accentSoft: string;
  };
  /** Hex (no #) values for the PPTX exporter. Mirrors cssVars but PPTX needs
   * the format pptxgenjs expects. */
  pptx: {
    paper: string;
    ink: string;
    inkSoft: string;
    accent: string;
    rule: string;
  };
  /** Appended to every image-generation prompt. Should be 5-8 lines describing
   * palette, typography, composition rules, and aesthetic. */
  imagePromptAppendix: string;
};

const THEMES: Record<Exclude<ThemeId, "locked">, Theme> = {
  editorial: {
    id: "editorial",
    name: "Editorial",
    blurb: "Warm cream, deep ink, terracotta accent. The default look.",
    cssVars: {
      bg: "#f4ecd6",
      paper: "#fffaf0",
      ink: "#1f160f",
      inkSoft: "rgba(31, 22, 15, 0.7)",
      inkMuted: "rgba(31, 22, 15, 0.5)",
      rule: "rgba(31, 22, 15, 0.16)",
      ruleStrong: "rgba(31, 22, 15, 0.32)",
      accent: "#b8553a",
      accentSoft: "rgba(184, 85, 58, 0.12)"
    },
    pptx: {
      paper: "FFFAF0",
      ink: "1F160F",
      inkSoft: "5C4A3F",
      accent: "B8553A",
      rule: "D6CDB7"
    },
    imagePromptAppendix: `
Editorial business-presentation aesthetic. Calm, confident, and uncluttered.
Composition: generous negative space, balanced layout, single clear focal point.
Color palette: warm cream background (#fffaf0), deep navy or charcoal foreground, with at most one muted accent color (terracotta, sage, or muted teal).
Typography (when text appears in the image): clean modern sans-serif. Never script, never cartoon.
Avoid stock-art clichés, gradients, drop shadows, glossy 3D, and clip-art icons.
Treat the image as a single editorial illustration, not a busy infographic.
`.trim()
  },

  monochrome: {
    id: "monochrome",
    name: "Monochrome",
    blurb: "Off-white + ink. No accent color. Maximum restraint.",
    cssVars: {
      bg: "#f7f5f0",
      paper: "#ffffff",
      ink: "#0e0e0d",
      inkSoft: "rgba(14, 14, 13, 0.65)",
      inkMuted: "rgba(14, 14, 13, 0.4)",
      rule: "rgba(14, 14, 13, 0.12)",
      ruleStrong: "rgba(14, 14, 13, 0.28)",
      accent: "#0e0e0d",
      accentSoft: "rgba(14, 14, 13, 0.08)"
    },
    pptx: {
      paper: "FFFFFF",
      ink: "0E0E0D",
      inkSoft: "595858",
      accent: "0E0E0D",
      rule: "DDDCD8"
    },
    imagePromptAppendix: `
Strict monochrome editorial aesthetic. Black ink on warm white only.
Single focal subject, generous white space, no decorative elements.
Composition: think New York Times opinion-section illustration or a Pentagram poster.
Typography (if any): clean grotesk or transitional serif, no embellishment.
Absolutely no color besides black, white, and warm gray. No gradients, no shadows, no 3D.
Treat as a high-contrast print-ready illustration.
`.trim()
  },

  pitch: {
    id: "pitch",
    name: "Pitch deck",
    blurb: "Deep navy ground, electric accent. For high-stakes pitches.",
    cssVars: {
      bg: "#0d1623",
      paper: "#101a2c",
      ink: "#f2f0e8",
      inkSoft: "rgba(242, 240, 232, 0.72)",
      inkMuted: "rgba(242, 240, 232, 0.5)",
      rule: "rgba(242, 240, 232, 0.14)",
      ruleStrong: "rgba(242, 240, 232, 0.3)",
      accent: "#5dd4c4",
      accentSoft: "rgba(93, 212, 196, 0.16)"
    },
    pptx: {
      paper: "101A2C",
      ink: "F2F0E8",
      inkSoft: "B7B3A8",
      accent: "5DD4C4",
      rule: "263147"
    },
    imagePromptAppendix: `
High-stakes pitch deck aesthetic. Deep navy background (#101a2c), bright cool accent (electric mint or icy blue).
Composition: bold and confident, geometric, high contrast.
Color palette: dark navy base, warm off-white text/figure, single electric accent for emphasis.
Typography (if any): bold modern sans-serif (think Inter Display or Söhne Bold).
No softness, no gradients, no decorative flourishes. Treat as a Stripe / Linear / Vercel-grade product visual.
Edges should be crisp, contrast should be punchy.
`.trim()
  }
};

export const PRESET_THEMES = THEMES;

export const PRESET_THEME_LIST: Theme[] = [THEMES.editorial, THEMES.monochrome, THEMES.pitch];

export const DEFAULT_THEME = THEMES.editorial;

export function getPresetTheme(id: string): Theme | null {
  if (id === "editorial" || id === "monochrome" || id === "pitch") {
    return THEMES[id];
  }
  return null;
}

/**
 * Build a runtime "locked" theme from a style DNA extracted from a slide image.
 * Inherits typography + structure from the editorial preset, overrides palette
 * + image appendix from the extracted DNA. Falls back to the editorial preset
 * for any field the extractor didn't return.
 */
export function buildLockedTheme(dna: {
  palette: { paper: string; ink: string; accent: string };
  mood?: string;
  imagePromptAppendix: string;
}): Theme {
  const base = THEMES.editorial;
  const paper = sanitizeHex(dna.palette.paper) ?? base.cssVars.paper;
  const ink = sanitizeHex(dna.palette.ink) ?? base.cssVars.ink;
  const accent = sanitizeHex(dna.palette.accent) ?? base.cssVars.accent;

  return {
    id: "locked",
    name: dna.mood ? `Locked (${dna.mood})` : "Locked from slide",
    blurb: "Palette + style extracted from a generated slide.",
    cssVars: {
      bg: paper,
      paper,
      ink,
      inkSoft: rgbaFromHex(ink, 0.7),
      inkMuted: rgbaFromHex(ink, 0.5),
      rule: rgbaFromHex(ink, 0.16),
      ruleStrong: rgbaFromHex(ink, 0.32),
      accent,
      accentSoft: rgbaFromHex(accent, 0.14)
    },
    pptx: {
      paper: stripHash(paper),
      ink: stripHash(ink),
      inkSoft: stripHash(ink),
      accent: stripHash(accent),
      rule: base.pptx.rule
    },
    imagePromptAppendix: dna.imagePromptAppendix
  };
}

/**
 * Validate hex colors. Accepts "#abc" / "#abcdef"; returns the 6-char form
 * lowercased and prefixed, or null if it's not a valid hex string.
 */
export function sanitizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!match) return null;
  const hex = match[1];
  const full =
    hex.length === 3
      ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      : hex;
  return `#${full.toLowerCase()}`;
}

function stripHash(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1).toUpperCase() : hex.toUpperCase();
}

function rgbaFromHex(hex: string, alpha: number): string {
  const sanitized = sanitizeHex(hex);
  if (!sanitized) return `rgba(0, 0, 0, ${alpha})`;
  const r = parseInt(sanitized.slice(1, 3), 16);
  const g = parseInt(sanitized.slice(3, 5), 16);
  const b = parseInt(sanitized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
