/**
 * Unit tests for the theme system. No network, no AI — just shape + math.
 */

import { describe, it, expect } from "vitest";
import {
  buildLockedTheme,
  buildCustomThemeFromPalette,
  coercePersistedTheme,
  DEFAULT_THEME,
  DEFAULT_THEME_TYPOGRAPHY,
  PRESET_THEMES,
  THEME_PICKER_PRESETS,
  getPresetTheme,
  patchThemeColors,
  patchThemeTypography,
  sanitizeHex
} from "../../lib/ai/themes";

describe("preset themes", () => {
  it("picker lists Default + Monochrome only", () => {
    expect(THEME_PICKER_PRESETS.map((t) => t.id)).toEqual(["default", "monochrome"]);
  });

  it("pitch legacy preset still exists for shared decks / export ids", () => {
    expect(PRESET_THEMES.pitch.id).toBe("pitch");
  });

  it("default theme id is default", () => {
    expect(DEFAULT_THEME.id).toBe("default");
    expect(DEFAULT_THEME.typography?.displayFont).toBe("serif");
  });

  it("every built-in preset has the full Theme shape", () => {
    for (const t of Object.values(PRESET_THEMES)) {
      expect(t.cssVars.bg).toBeTruthy();
      expect(t.cssVars.paper).toBeTruthy();
      expect(t.typography?.slideScale).toBeTruthy();
      expect(t.pptx.accent).toMatch(/^[0-9A-F]{6}$/);
      expect(t.imagePromptAppendix.length).toBeGreaterThan(80);
    }
  });

  it("getPresetTheme maps editorial → default", () => {
    expect(getPresetTheme("xyz")).toBeNull();
    expect(getPresetTheme("locked")).toBeNull();
    expect(getPresetTheme("default")?.id).toBe("default");
    expect(getPresetTheme("editorial")?.id).toBe("default");
  });

  it("appendices are distinctive", () => {
    expect(PRESET_THEMES.default.imagePromptAppendix).toMatch(/Valon/i);
    expect(PRESET_THEMES.monochrome.imagePromptAppendix).toMatch(/monochrome/i);
    expect(PRESET_THEMES.pitch.imagePromptAppendix).toMatch(/navy|electric|pitch/i);
  });

  it("Default preset uses Valon gold accent in CSS + pptx", () => {
    expect(PRESET_THEMES.default.cssVars.accent.toLowerCase()).toBe("#e19614");
    expect(PRESET_THEMES.default.pptx.accent).toBe("E19614");
  });

  it("coercePersistedTheme snaps presets to canonical objects", () => {
    const tweaked = {
      ...DEFAULT_THEME,
      cssVars: { ...DEFAULT_THEME.cssVars, accent: "#ff0000" }
    };
    expect(coercePersistedTheme(tweaked)).toEqual(DEFAULT_THEME);
    expect(coercePersistedTheme({ id: "monochrome", nonsense: true })).toEqual(PRESET_THEMES.monochrome);
  });

  it("coerces legacy website import source to default custom", () => {
    const base = buildCustomThemeFromPalette({
      paper: "#fff",
      ink: "#000",
      accent: "#336699",
      bg: "#f4f4f4",
      source: "default",
      name: "From website"
    });
    const migrated = coercePersistedTheme(Object.assign({}, base, { source: "website" }));
    expect(migrated.source).toBe("default");
    expect(migrated.name).toBe("Custom theme");
  });

  it("coercePersistedTheme keeps valid locked + custom themes", () => {
    expect(coercePersistedTheme(null)).toEqual(expect.objectContaining({ id: "default" }));
    expect(coercePersistedTheme({ id: "locked", foo: 1 })).toEqual(DEFAULT_THEME);

    const custom = buildCustomThemeFromPalette({
      paper: "#fff",
      ink: "#000",
      accent: "#336699",
      bg: "#f4f4f4",
      source: "default",
      name: "TestCo"
    });
    expect(coercePersistedTheme(custom)).toMatchObject({
      id: "custom",
      name: "TestCo",
      typography: DEFAULT_THEME_TYPOGRAPHY
    });

    const locked = buildLockedTheme({
      palette: { paper: "#fff", ink: "#000", accent: "#ff0000" },
      mood: "noir",
      imagePromptAppendix: "Noir chiaroscuro etc."
    });
    expect(coercePersistedTheme(locked)).toMatchObject({ id: "locked" });

    /** Typography defaults applied */
    expect(coercePersistedTheme(custom).typography?.slideScale).toBe(1);
  });
});

describe("custom + patch helpers", () => {
  it("buildCustomThemeFromPalette produces custom id", () => {
    const t = buildCustomThemeFromPalette({
      paper: "#ffffff",
      ink: "#111111",
      accent: "#c45e3c",
      bg: "#eceae6",
      source: "default"
    });
    expect(t.id).toBe("custom");
    expect(t.source).toBe("default");
  });

  it("patchThemeColors forks presets to custom", () => {
    const next = patchThemeColors(PRESET_THEMES.default, { paper: "#eaeaea" });
    expect(next.id).toBe("custom");
    expect(next.cssVars.paper).toMatch(/#eaeaea/);
  });

  it("patchThemeTypography forks presets", () => {
    const next = patchThemeTypography(PRESET_THEMES.monochrome, { slideScale: 1.1 });
    expect(next.id).toBe("custom");
    expect(next.typography?.slideScale).toBeCloseTo(1.1);
  });

  it("patchThemeTypography clamps slideScale", () => {
    const t = patchThemeTypography(
      coercePersistedTheme({
        ...buildCustomThemeFromPalette({
          paper: "#fff",
          ink: "#000",
          accent: "#999",
          bg: "#eee",
          source: "default"
        }),
        id: "custom"
      }),
      { slideScale: 99 }
    );
    expect(t.typography?.slideScale).toBe(1.4);
  });
});

describe("sanitizeHex", () => {
  it("accepts 6-char hex with or without #", () => {
    expect(sanitizeHex("#abcdef")).toBe("#abcdef");
    expect(sanitizeHex("ABCDEF")).toBe("#abcdef");
  });

  it("expands 3-char hex to 6-char", () => {
    expect(sanitizeHex("#abc")).toBe("#aabbcc");
    expect(sanitizeHex("F0A")).toBe("#ff00aa");
  });

  it("rejects malformed input", () => {
    expect(sanitizeHex("not-a-hex")).toBeNull();
    expect(sanitizeHex("#abcde")).toBeNull();
    expect(sanitizeHex(123)).toBeNull();
    expect(sanitizeHex(null)).toBeNull();
    expect(sanitizeHex(undefined)).toBeNull();
  });
});

describe("buildLockedTheme", () => {
  it("constructs a valid Theme from a complete DNA", () => {
    const theme = buildLockedTheme({
      palette: { paper: "#fff", ink: "#000", accent: "#ff0000" },
      mood: "noir",
      imagePromptAppendix: "Noir chiaroscuro etc."
    });
    expect(theme.id).toBe("locked");
    expect(theme.name).toMatch(/noir/i);
    expect(theme.typography?.displayFont).toBe("serif");
    expect(theme.pptx.accent).toBe("FF0000");
    expect(theme.imagePromptAppendix).toBe("Noir chiaroscuro etc.");
  });

  it("derives ink-soft / rule colors from ink with appropriate alpha", () => {
    const theme = buildLockedTheme({
      palette: { paper: "#fff", ink: "#102030", accent: "#abc" },
      imagePromptAppendix: "x".repeat(50)
    });
    expect(theme.cssVars.inkSoft).toBe("rgba(16, 32, 48, 0.7)");
    expect(theme.cssVars.accentSoft).toMatch(/rgba\(170, 187, 204/);
  });

  it("falls back to defaults for unparseable hex fields", () => {
    const theme = buildLockedTheme({
      palette: { paper: "garbage", ink: "also-garbage", accent: "#bad" },
      imagePromptAppendix: "x".repeat(50)
    });
    expect(theme.cssVars.paper).toBe(DEFAULT_THEME.cssVars.paper);
    expect(theme.cssVars.ink).toBe(DEFAULT_THEME.cssVars.ink);
    expect(theme.cssVars.accent).toBe("#bbaadd");
  });
});
