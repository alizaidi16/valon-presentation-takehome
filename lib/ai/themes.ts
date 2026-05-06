/**
 * Theme system. Controls layout slide CSS vars, PPTX colors, image-prompt appendix,
 * and optional typography for slides.
 */

export type ThemeId = "default" | "monochrome" | "pitch" | "custom" | "locked";

/** Which template the user started from when using a custom (non-preset) theme. */
export type ThemeSource = "default" | "monochrome";

export type ThemeFontStack = "serif" | "sans" | "mono";

export type ThemeTypography = {
  displayFont: ThemeFontStack;
  bodyFont: ThemeFontStack;
  /** 0.85–1.35, scales layout slide type (via CSS var). */
  slideScale: number;
};

export const DEFAULT_THEME_TYPOGRAPHY: ThemeTypography = {
  displayFont: "serif",
  bodyFont: "sans",
  slideScale: 1
};

export type Theme = {
  id: ThemeId;
  /** Where this theme came from when id is custom or when user edited a preset. */
  source?: ThemeSource;
  /** Human-readable label for the picker. */
  name: string;
  /** One-sentence description for tooltips/help. */
  blurb: string;
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
  pptx: {
    paper: string;
    ink: string;
    inkSoft: string;
    accent: string;
    rule: string;
  };
  imagePromptAppendix: string;
  typography?: ThemeTypography;
};

const THEMES: Record<"default" | "monochrome" | "pitch", Theme> = {
  default: {
    id: "default",
    source: "default",
    name: "Default",
    blurb: "Cream paper, gold highlights, editorial serif + sans — matches Valon marketing tokens.",
    cssVars: {
      bg: "#f8f6f3",
      paper: "#ffffff",
      ink: "#20190f",
      inkSoft: "rgba(92, 84, 60, 0.9)",
      inkMuted: "rgba(130, 112, 87, 0.95)",
      rule: "rgba(35, 24, 16, 0.1)",
      ruleStrong: "rgba(35, 24, 16, 0.2)",
      accent: "#e19614",
      accentSoft: "rgba(225, 150, 20, 0.14)"
    },
    pptx: {
      paper: "FFFFFF",
      ink: "20190F",
      inkSoft: "5C543C",
      accent: "E19614",
      rule: "DCD2C6"
    },
    imagePromptAppendix: `
Follow the public Valon marketing design language (valon.ai): Valon Gold (#e19614) only for small highlights,
cream-and-stone Base ramp backgrounds (#fffdfa, #f8f6f3, #ece4dd) and deep Base ink (#20190f, #5c543c for secondary text).
Composition: generous whitespace, cards defined by soft shadow and subtle tone (no heavy borders),
large high-contrast serif headlines, clean geometric sans for body and UI when text appears.
Avoid terracotta/orange that is not the official gold, rainbow gradients, glossy 3D, stock clip-art, and busy dashboards.
`.trim(),
    typography: { ...DEFAULT_THEME_TYPOGRAPHY }
  },

  monochrome: {
    id: "monochrome",
    source: "monochrome",
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
`.trim(),
    typography: { displayFont: "serif", bodyFont: "sans", slideScale: 1 }
  },

  pitch: {
    id: "pitch",
    source: "default",
    name: "Pitch deck",
    blurb: "Deep navy ground, electric accent. Legacy preset for shared decks.",
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
`.trim(),
    typography: { displayFont: "sans", bodyFont: "sans", slideScale: 1 }
  }
};

export const PRESET_THEMES = THEMES;

/** Shown in sidebar: Default + Monochrome. */
export const THEME_PICKER_PRESETS: Theme[] = [THEMES.default, THEMES.monochrome];

export const DEFAULT_THEME = THEMES.default;

function normalizeThemeTypography(t?: ThemeTypography): ThemeTypography {
  if (!t) return { ...DEFAULT_THEME_TYPOGRAPHY };
  const slideScale = Math.min(1.4, Math.max(0.8, t.slideScale || 1));
  return {
    displayFont: t.displayFont === "mono" || t.displayFont === "sans" ? t.displayFont : "serif",
    bodyFont: t.bodyFont === "mono" || t.bodyFont === "serif" ? t.bodyFont : "sans",
    slideScale
  };
}

/** Attach defaults for older persisted themes missing typography. */
export function withDefaultTypography(theme: Theme): Theme {
  return { ...theme, typography: normalizeThemeTypography(theme.typography) };
}

/** True when parsed JSON matches a minimal persisted Theme-like object. */
export function isThemeShape(raw: unknown): raw is Partial<Theme> & { id: ThemeId } {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const cv = o.cssVars;
  const px = o.pptx;
  if (
    typeof o.id !== "string" ||
    !cv ||
    typeof cv !== "object" ||
    !px ||
    typeof px !== "object"
  ) {
    return false;
  }
  const vars = cv as Record<string, unknown>;
  const ppt = px as Record<string, unknown>;
  return Boolean(
    typeof vars.paper === "string" &&
      typeof vars.ink === "string" &&
      typeof vars.accent === "string" &&
      typeof ppt.paper === "string" &&
      typeof ppt.ink === "string" &&
      typeof ppt.accent === "string"
  );
}

/**
 * Hydration: snap known presets to canonical; accept custom/locked payloads;
 * migrate legacy `editorial` id → default.
 */
export function coercePersistedTheme(raw: unknown): Theme {
  if (!raw || typeof raw !== "object") return withDefaultTypography(DEFAULT_THEME);
  const o = raw as Record<string, unknown>;

  /** Legacy share/localStorage used `editorial` before rename to `default`. */
  const rawId = typeof o.id === "string" ? o.id : "";
  const migrateId = rawId === "editorial" ? "default" : rawId;

  if (migrateId === "default" || migrateId === "monochrome" || migrateId === "pitch") {
    return withDefaultTypography(THEMES[migrateId]);
  }
  if ((migrateId === "custom" || migrateId === "locked") && isThemeShape(raw)) {
    let t = raw as Theme;
    const legacySrc = (raw as Record<string, unknown>).source;
    if (legacySrc === "website") {
      t = {
        ...t,
        source: "default",
        name: t.name === "From website" || !t.name?.trim() ? "Custom theme" : t.name
      };
    }
    return withDefaultTypography(t);
  }
  return withDefaultTypography(DEFAULT_THEME);
}

export function getPresetTheme(id: string): Theme | null {
  if (id === "default" || id === "monochrome" || id === "pitch") {
    return THEMES[id];
  }
  if (id === "editorial") {
    return THEMES.default;
  }
  return null;
}

export function buildCustomThemeFromPalette(input: {
  paper: string;
  ink: string;
  accent: string;
  bg: string;
  name?: string;
  source: ThemeSource;
  /** Optional — defaults to a palette-driven appendix for image prompts. */
  imagePromptAppendix?: string;
}): Theme {
  const paper = sanitizeHex(input.paper) ?? DEFAULT_THEME.cssVars.paper;
  const ink = sanitizeHex(input.ink) ?? DEFAULT_THEME.cssVars.ink;
  const accent = sanitizeHex(input.accent) ?? DEFAULT_THEME.cssVars.accent;
  const bg = sanitizeHex(input.bg) ?? paper;

  const appendix =
    input.imagePromptAppendix?.trim() ||
    `
Brand-aligned visuals using this palette: paper ${paper}, dominant ink ${ink}, accent ${accent}, ground ${bg}.
Composition: clean editorial slide layout, generous margins, restrained decoration.
Typography: professional pairing—serif for headlines when formal, geometric sans otherwise.
Absolutely no clipart watermarks or stock-photo poses. One clear focal idea per slide.
`.trim();

  return withDefaultTypography({
    id: "custom",
    source: input.source,
    name: input.name?.trim() || "Custom theme",
    blurb: "User-edited or imported palette.",
    cssVars: {
      bg,
      paper,
      ink,
      inkSoft: rgbaFromHex(ink, 0.72),
      inkMuted: rgbaFromHex(ink, 0.5),
      rule: rgbaFromHex(ink, 0.14),
      ruleStrong: rgbaFromHex(ink, 0.28),
      accent,
      accentSoft: rgbaFromHex(accent, 0.16)
    },
    pptx: {
      paper: stripHash(paper),
      ink: stripHash(ink),
      inkSoft: stripHash(ink),
      accent: stripHash(accent),
      rule: DEFAULT_THEME.pptx.rule
    },
    imagePromptAppendix: appendix,
    typography: { ...DEFAULT_THEME_TYPOGRAPHY }
  });
}

/**
 * Duplicate a preset (or any theme) into an editable custom copy.
 */
export function forkThemeAsCustom(base: Theme, label?: string): Theme {
  return withDefaultTypography({
    ...base,
    id: "custom",
    source:
      base.source === "monochrome" ? "monochrome" : "default",
    name: label?.trim() || `${base.name} (edited)`,
    blurb: "Customized theme.",
    typography: normalizeThemeTypography(base.typography)
  });
}

/**
 * Build a runtime "locked" theme from a style DNA extracted from a slide image.
 */
export function buildLockedTheme(dna: {
  palette: { paper: string; ink: string; accent: string };
  mood?: string;
  imagePromptAppendix: string;
}): Theme {
  const base = THEMES.default;
  const paper = sanitizeHex(dna.palette.paper) ?? base.cssVars.paper;
  const ink = sanitizeHex(dna.palette.ink) ?? base.cssVars.ink;
  const accent = sanitizeHex(dna.palette.accent) ?? base.cssVars.accent;

  return withDefaultTypography({
    id: "locked",
    source: "default",
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
    imagePromptAppendix: dna.imagePromptAppendix,
    typography: { ...DEFAULT_THEME_TYPOGRAPHY }
  });
}

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

/**
 * Apply partial color updates; re-derives soft ink/accent from hex when solid colors change.
 */
export function patchThemeColors(theme: Theme, patch: Partial<Theme["cssVars"]>): Theme {
  const next = { ...theme.cssVars, ...patch };
  const solidInk = sanitizeHex(next.ink) ?? theme.cssVars.ink;
  const solidAccent = sanitizeHex(next.accent) ?? theme.cssVars.accent;
  const solidPaper = sanitizeHex(next.paper) ?? theme.cssVars.paper;
  const solidBg = sanitizeHex(next.bg) ?? theme.cssVars.bg;

  const cssVars: Theme["cssVars"] = {
    bg: solidBg,
    paper: solidPaper,
    ink: solidInk,
    accent: solidAccent,
    inkSoft: next.inkSoft.startsWith("rgba") ? next.inkSoft : rgbaFromHex(solidInk, 0.72),
    inkMuted: next.inkMuted.startsWith("rgba") ? next.inkMuted : rgbaFromHex(solidInk, 0.5),
    rule: next.rule.startsWith("rgba") ? next.rule : rgbaFromHex(solidInk, 0.14),
    ruleStrong: next.ruleStrong.startsWith("rgba") ? next.ruleStrong : rgbaFromHex(solidInk, 0.28),
    accentSoft: next.accentSoft.startsWith("rgba") ? next.accentSoft : rgbaFromHex(solidAccent, 0.16)
  };

  const wasPreset = theme.id === "default" || theme.id === "monochrome" || theme.id === "pitch";

  return withDefaultTypography({
    ...theme,
    id: wasPreset || theme.id === "locked" ? "custom" : theme.id,
    source:
      theme.source ??
      (theme.id === "monochrome" ? "monochrome" : "default"),
    name: wasPreset ? `${THEMES[theme.id as "default" | "monochrome" | "pitch"].name} (edited)` : theme.name,
    cssVars,
    pptx: {
      paper: stripHash(cssVars.paper),
      ink: stripHash(cssVars.ink),
      inkSoft: stripHash(cssVars.ink),
      accent: stripHash(cssVars.accent),
      rule: theme.pptx.rule
    }
  });
}

export function patchThemeTypography(theme: Theme, patch: Partial<ThemeTypography>): Theme {
  const typography = normalizeThemeTypography({ ...DEFAULT_THEME_TYPOGRAPHY, ...theme.typography, ...patch });
  const wasPreset = theme.id === "default" || theme.id === "monochrome" || theme.id === "pitch";
  return withDefaultTypography({
    ...theme,
    id: wasPreset || theme.id === "locked" ? "custom" : theme.id,
    source:
      theme.source ??
      (theme.id === "monochrome" ? "monochrome" : "default"),
    name: wasPreset ? `${THEMES[theme.id as "default" | "monochrome" | "pitch"].name} (edited)` : theme.name,
    typography
  });
}
