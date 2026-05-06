/**
 * Unit tests for thumbnail heading helper.
 */

import { describe, expect, it } from "vitest";
import { slideThumbnailHeading } from "../../lib/ui/slide-thumbnail-heading";

describe("slideThumbnailHeading", () => {
  const base = { name: "Outline name", prompt: "" };

  it("uses layout headline for bullets / grid", () => {
    expect(
      slideThumbnailHeading({
        ...base,
        prompt: "ignore",
        layout: { kind: "bullets", headline: "  Key wins  ", bullets: ["a"] }
      })
    ).toBe("Key wins");
  });

  it("title layout ignores outline name — prompt line when no headline", () => {
    expect(
      slideThumbnailHeading({
        name: "Outline title",
        prompt: "  Hero opener  ",
        layout: { kind: "title", headline: "", subtitle: "sub" }
      })
    ).toBe("Hero opener");
    expect(
      slideThumbnailHeading({
        name: "Outline title",
        prompt: "",
        layout: { kind: "title", headline: "", subtitle: "sub" }
      })
    ).toBe("\u2014");
  });

  it("falls back for stats without headline", () => {
    expect(
      slideThumbnailHeading({
        ...base,
        layout: {
          kind: "stats",
          stats: [{ value: "94%", label: "satisfaction" }]
        }
      })
    ).toBe("94% satisfaction");
  });

  it("prefers slide name over prompt line for list index zero", () => {
    expect(
      slideThumbnailHeading(
        {
          name: "Slide 1",
          prompt: "  Hero skyline at dusk\nextra line  "
        },
        { listIndex: 0 }
      )
    ).toBe("Slide 1");
  });

  it("truncates very long slide names when list index zero", () => {
    const name = "a".repeat(80);
    const out = slideThumbnailHeading({ name, prompt: "prompt line" }, { listIndex: 0 });
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("…")).toBe(true);
  });

  it("list index zero with empty name still uses prompt logic", () => {
    expect(
      slideThumbnailHeading(
        {
          name: "   ",
          prompt: "  Hero skyline\nmore"
        },
        { listIndex: 0 }
      )
    ).toBe("Hero skyline");
  });

  it("uses first prompt line when there is no layout", () => {
    expect(
      slideThumbnailHeading({
        name: "Slide 3",
        prompt: "  Hero skyline at dusk\nextra line  "
      })
    ).toBe("Hero skyline at dusk");
  });

  it("truncates very long prompt lines", () => {
    const line = "a".repeat(80);
    const out = slideThumbnailHeading({ name: "N", prompt: line });
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("…")).toBe(true);
  });
});
