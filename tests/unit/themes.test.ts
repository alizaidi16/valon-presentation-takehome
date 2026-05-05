/**
 * Unit tests for the theme system. No network, no AI — just shape + math.
 */

import { describe, it, expect } from "vitest";
import {
  buildLockedTheme,
  coercePersistedTheme,
  DEFAULT_THEME,
  PRESET_THEME_LIST,
  getPresetTheme,
  sanitizeHex
} from "../../lib/ai/themes";

describe("preset themes", () => {
  it("includes editorial / monochrome / pitch", () => {
    const ids = PRESET_THEME_LIST.map((t) => t.id);
    expect(ids).toEqual(["editorial", "monochrome", "pitch"]);
  });

  it("default theme is editorial", () => {
    expect(DEFAULT_THEME.id).toBe("editorial");
  });

  it("every preset has the full Theme shape", () => {
    for (const t of PRESET_THEME_LIST) {
      expect(t.cssVars.bg).toBeTruthy();
      expect(t.cssVars.paper).toBeTruthy();
      expect(t.cssVars.ink).toBeTruthy();
      expect(t.cssVars.accent).toBeTruthy();
      expect(t.pptx.paper).toMatch(/^[0-9A-F]{6}$/);
      expect(t.pptx.ink).toMatch(/^[0-9A-F]{6}$/);
      expect(t.pptx.accent).toMatch(/^[0-9A-F]{6}$/);
      // Appendix is the meat of style enforcement; should be substantive.
      expect(t.imagePromptAppendix.length).toBeGreaterThan(100);
    }
  });

  it("getPresetTheme returns null for unknown ids", () => {
    expect(getPresetTheme("xyz")).toBeNull();
    expect(getPresetTheme("locked")).toBeNull(); // locked is runtime-only
    expect(getPresetTheme("editorial")?.id).toBe("editorial");
  });

  it("appendices mention their distinguishing palette", () => {
    expect(PRESET_THEME_LIST.find((t) => t.id === "editorial")?.imagePromptAppendix).toMatch(
      /cream/i
    );
    expect(PRESET_THEME_LIST.find((t) => t.id === "monochrome")?.imagePromptAppendix).toMatch(
      /monochrome/i
    );
    expect(PRESET_THEME_LIST.find((t) => t.id === "pitch")?.imagePromptAppendix).toMatch(
      /navy|electric|pitch/i
    );
  });

  it("editorial preset uses Valon gold as slide accent / PPTX highlight", () => {
    const ed = PRESET_THEME_LIST.find((t) => t.id === "editorial");
    expect(ed?.cssVars.accent.toLowerCase()).toBe("#e19614");
    expect(ed?.pptx.accent).toBe("E19614");
  });

  it("coercePersistedTheme snaps presets to canonical objects", () => {
    const tweaked = {
      ...DEFAULT_THEME,
      cssVars: { ...DEFAULT_THEME.cssVars, accent: "#ff0000" }
    };
    expect(coercePersistedTheme(tweaked)).toEqual(DEFAULT_THEME);
    expect(coercePersistedTheme({ id: "monochrome", nonsense: true })).toEqual(
      PRESET_THEME_LIST.find((t) => t.id === "monochrome")
    );
  });

  it("coercePersistedTheme keeps valid locked themes and falls back cleanly", () => {
    expect(coercePersistedTheme(null)).toEqual(DEFAULT_THEME);
    expect(coercePersistedTheme({ id: "locked", foo: 1 })).toEqual(DEFAULT_THEME);
    const locked = buildLockedTheme({
      palette: { paper: "#fff", ink: "#000", accent: "#336699" },
      imagePromptAppendix: "custom appendix text that is long enough for tests maybe"
    });
    locked.imagePromptAppendix = locked.imagePromptAppendix.padEnd(120, ".");
    expect(coercePersistedTheme(locked)).toEqual(locked);
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
    expect(sanitizeHex("#abcde")).toBeNull(); // wrong length
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
    expect(theme.cssVars.paper).toBe("#ffffff");
    expect(theme.cssVars.ink).toBe("#000000");
    expect(theme.cssVars.accent).toBe("#ff0000");
    expect(theme.pptx.paper).toBe("FFFFFF");
    expect(theme.pptx.ink).toBe("000000");
    expect(theme.pptx.accent).toBe("FF0000");
    expect(theme.imagePromptAppendix).toBe("Noir chiaroscuro etc.");
  });

  it("derives ink-soft / rule colors from ink with appropriate alpha", () => {
    const theme = buildLockedTheme({
      palette: { paper: "#fff", ink: "#102030", accent: "#abc" },
      imagePromptAppendix: "x".repeat(50)
    });
    expect(theme.cssVars.inkSoft).toBe("rgba(16, 32, 48, 0.7)");
    expect(theme.cssVars.inkMuted).toBe("rgba(16, 32, 48, 0.5)");
    expect(theme.cssVars.rule).toBe("rgba(16, 32, 48, 0.16)");
    expect(theme.cssVars.accentSoft).toMatch(/rgba\(170, 187, 204, 0\.14\)/);
  });

  it("falls back to editorial defaults for unparseable hex", () => {
    const theme = buildLockedTheme({
      palette: { paper: "garbage", ink: "also-garbage", accent: "#bad" },
      imagePromptAppendix: "x".repeat(50)
    });
    expect(theme.cssVars.paper).toBe(DEFAULT_THEME.cssVars.paper);
    expect(theme.cssVars.ink).toBe(DEFAULT_THEME.cssVars.ink);
    // Accent was valid (#bad → #bbaadd), so it goes through
    expect(theme.cssVars.accent).toBe("#bbaadd");
  });

  it("falls back to 'Locked from slide' when mood is missing", () => {
    const theme = buildLockedTheme({
      palette: { paper: "#fff", ink: "#000", accent: "#abc" },
      imagePromptAppendix: "x".repeat(50)
    });
    expect(theme.name).toBe("Locked from slide");
  });
});
