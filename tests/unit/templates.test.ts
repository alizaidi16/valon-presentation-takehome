import { describe, expect, it } from "vitest";

import { getTemplate, TEMPLATE_LIST } from "@/lib/templates";

describe("templates", () => {
  describe("TEMPLATE_LIST invariants", () => {
    it("has at least 3 templates", () => {
      expect(TEMPLATE_LIST.length).toBeGreaterThanOrEqual(3);
    });

    it.each(TEMPLATE_LIST)("$id has well-formed metadata + slides", (template) => {
      expect(template.id).toMatch(/^[a-z0-9-]+$/);
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.blurb.length).toBeGreaterThan(0);
      expect(template.scope.length).toBeGreaterThan(0);
      expect(template.slides.length).toBeGreaterThanOrEqual(4);
      // Cap at 12 to keep templates digestible.
      expect(template.slides.length).toBeLessThanOrEqual(12);
    });

    it.each(TEMPLATE_LIST)("$id slides each have prompt + name + format", (template) => {
      for (const slide of template.slides) {
        expect(slide.name.length).toBeGreaterThan(0);
        expect(slide.prompt.length).toBeGreaterThan(20);
        expect(slide.notes.length).toBeGreaterThan(0);
        expect(["title", "bullets", "grid", "stats", "image", "auto"]).toContain(
          slide.suggestedFormat
        );
      }
    });

    it("has unique template ids", () => {
      const ids = TEMPLATE_LIST.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("includes at least one image-format slide across templates", () => {
      // Visual variety matters — templates that are 100% bullets feel flat.
      const hasImage = TEMPLATE_LIST.some((t) =>
        t.slides.some((s) => s.suggestedFormat === "image")
      );
      expect(hasImage).toBe(true);
    });
  });

  describe("getTemplate", () => {
    it("returns the template by id", () => {
      const t = getTemplate("pitch");
      expect(t?.name).toMatch(/pitch/i);
    });

    it("returns null for unknown id", () => {
      expect(getTemplate("does-not-exist")).toBeNull();
    });
  });
});
