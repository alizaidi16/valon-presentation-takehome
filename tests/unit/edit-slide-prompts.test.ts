/**
 * Unit tests for revision prompt builders — deterministic contract for the model.
 */

import { describe, it, expect } from "vitest";
import {
  buildLayoutRevisionPrompt,
  mergeBriefWithEditRequest
} from "../../lib/ai/edit-slide-prompts";

describe("mergeBriefWithEditRequest", () => {
  it("merges brief and instruction when both present", () => {
    const out = mergeBriefWithEditRequest("  hero shot  ", "  warmer light  ");
    expect(out).toContain("hero shot");
    expect(out).toContain("warmer light");
    expect(out).toContain("Original slide brief");
    expect(out).toContain("User edit request");
  });

  it("handles empty brief", () => {
    expect(mergeBriefWithEditRequest("", "only instruction")).toContain("only instruction");
  });
});

describe("buildLayoutRevisionPrompt", () => {
  it("numbers bullets for index-aware edits", () => {
    const prompt = buildLayoutRevisionPrompt({
      layout: {
        kind: "bullets",
        headline: "H",
        bullets: ["a", "b", "c", "d"]
      },
      slideTitle: "Q4",
      brief: "Growth",
      instruction: 'Set bullet 4 to "x"'
    });
    expect(prompt).toContain('"kind": "bullets"');
    expect(prompt).toContain("1. a");
    expect(prompt).toContain("4. d");
    expect(prompt).toContain("fourth bullet");
    expect(prompt).toContain('Set bullet 4 to "x"');
  });

  it("locks layout kind in instructions", () => {
    const prompt = buildLayoutRevisionPrompt({
      layout: { kind: "title", headline: "Hi", subtitle: "There" },
      slideTitle: "",
      brief: "",
      instruction: "Center the vibe"
    });
    expect(prompt).toContain('Keep layout kind "title"');
    expect(prompt).toContain("Hi");
  });
});
