import { describe, it, expect } from "vitest";
import { elapsedSeconds, workingHint } from "../../lib/ui/working-feedback";

describe("elapsedSeconds", () => {
  it("returns 0 when startedAt is undefined", () => {
    expect(elapsedSeconds(undefined, 1_000_000)).toBe(0);
  });

  it("returns floor seconds difference", () => {
    expect(elapsedSeconds(1_000_000, 1_004_500)).toBe(4);
    expect(elapsedSeconds(1_000_000, 1_004_999)).toBe(4);
    expect(elapsedSeconds(1_000_000, 1_005_000)).toBe(5);
  });

  it("clamps to 0 when now < startedAt (clock skew safety)", () => {
    expect(elapsedSeconds(1_000_000, 999_000)).toBe(0);
  });
});

describe("workingHint — layout (non-image) path", () => {
  it("opens with 'Drafting layout content...' under 3s", () => {
    expect(workingHint({ suggestedFormat: "bullets", elapsed: 0 })).toMatch(/drafting/i);
    expect(workingHint({ suggestedFormat: "stats", elapsed: 2 })).toMatch(/drafting/i);
  });

  it("transitions to 'Wrapping up...' at 3s+", () => {
    expect(workingHint({ suggestedFormat: "grid", elapsed: 3 })).toMatch(/wrapping/i);
    expect(workingHint({ suggestedFormat: "title", elapsed: 30 })).toMatch(/wrapping/i);
  });
});

describe("workingHint — image (auto/image/undefined) path", () => {
  for (const format of ["image", "auto", undefined] as const) {
    it(`progresses through 4 phases when format is ${format ?? "undefined"}`, () => {
      expect(workingHint({ suggestedFormat: format, elapsed: 0 })).toMatch(/classifying/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 2 })).toMatch(/classifying/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 5 })).toMatch(/generating image/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 9 })).toMatch(/generating image/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 12 })).toMatch(/almost there/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 17 })).toMatch(/almost there/i);
      expect(workingHint({ suggestedFormat: format, elapsed: 25 })).toMatch(/longer than usual/i);
    });
  }

  it("never returns the empty string", () => {
    for (let elapsed = 0; elapsed < 40; elapsed++) {
      expect(workingHint({ suggestedFormat: "auto", elapsed }).length).toBeGreaterThan(0);
      expect(workingHint({ suggestedFormat: "bullets", elapsed }).length).toBeGreaterThan(0);
    }
  });
});
