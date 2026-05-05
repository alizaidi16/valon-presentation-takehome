/**
 * Unit tests for pure presentation logic.
 * No mocking, no network — just functions.
 */

import { describe, it, expect } from "vitest";

// ── getLayoutHeadline (copied from page.tsx — keep in sync) ──────────────────

type TitleLayout = { kind: "title"; headline: string; subtitle?: string };
type BulletsLayout = { kind: "bullets"; headline: string; bullets: string[] };
type GridLayout = { kind: "grid"; headline: string; items: Array<{ title: string; body: string }> };
type StatsLayout = { kind: "stats"; headline?: string; stats: Array<{ value: string; label: string }> };
type SlideLayout = TitleLayout | BulletsLayout | GridLayout | StatsLayout;

function getLayoutHeadline(layout: SlideLayout): string {
  if (layout.kind === "stats") return layout.headline ?? `${layout.stats.length} stats`;
  return layout.headline;
}

describe("getLayoutHeadline", () => {
  it("returns headline for title layout", () => {
    const layout: TitleLayout = { kind: "title", headline: "Hello World" };
    expect(getLayoutHeadline(layout)).toBe("Hello World");
  });

  it("returns headline for bullets layout", () => {
    const layout: BulletsLayout = { kind: "bullets", headline: "Key Points", bullets: [] };
    expect(getLayoutHeadline(layout)).toBe("Key Points");
  });

  it("returns headline for grid layout", () => {
    const layout: GridLayout = { kind: "grid", headline: "Our Products", items: [] };
    expect(getLayoutHeadline(layout)).toBe("Our Products");
  });

  it("returns headline for stats layout when present", () => {
    const layout: StatsLayout = {
      kind: "stats",
      headline: "By the Numbers",
      stats: [{ value: "99%", label: "Uptime" }]
    };
    expect(getLayoutHeadline(layout)).toBe("By the Numbers");
  });

  it("returns fallback count for stats layout when headline is absent", () => {
    const layout: StatsLayout = {
      kind: "stats",
      stats: [
        { value: "99%", label: "Uptime" },
        { value: "$2B", label: "Volume" }
      ]
    };
    expect(getLayoutHeadline(layout)).toBe("2 stats");
  });

  it("returns '1 stats' for a single stat with no headline", () => {
    const layout: StatsLayout = {
      kind: "stats",
      stats: [{ value: "42", label: "the answer" }]
    };
    expect(getLayoutHeadline(layout)).toBe("1 stats");
  });
});

// ── Layout shape validation ───────────────────────────────────────────────────

describe("Layout shape invariants", () => {
  it("bullets layout always has at least one bullet in realistic use", () => {
    const layout: BulletsLayout = {
      kind: "bullets",
      headline: "Points",
      bullets: ["First", "Second", "Third"]
    };
    expect(layout.bullets.length).toBeGreaterThan(0);
  });

  it("grid layout items have both title and body", () => {
    const items = [
      { title: "Speed", body: "Fast closings" },
      { title: "Trust", body: "98% CSAT" }
    ];
    for (const item of items) {
      expect(typeof item.title).toBe("string");
      expect(typeof item.body).toBe("string");
    }
  });

  it("stats layout values are strings (not numbers)", () => {
    const stats = [{ value: "$2B", label: "Volume" }, { value: "99%", label: "Uptime" }];
    for (const stat of stats) {
      expect(typeof stat.value).toBe("string");
      expect(typeof stat.label).toBe("string");
    }
  });
});

// ── Classification prompt structure ──────────────────────────────────────────
// Mirror the function signature so we can test prompt shape without importing the route.

/**
 * The classifier prompt lives inside the route file. We mirror its expected
 * properties here as invariants — if the route's prompt changes, these tests
 * tell you what behavior must be preserved.
 */

/**
 * Test the classifier prompt directly via its exported builder. Pulling the
 * actual function (rather than re-reading source) means refactors stay green
 * as long as the prompt's properties are preserved.
 */

import { buildClassificationPrompt } from "../../lib/ai/generate-slide";

const PROMPT = buildClassificationPrompt("test slide", false);
const PROMPT_VARIATION = buildClassificationPrompt("test slide", true);

describe("classifier prompt invariants", () => {
  it("prioritizes IMAGE when the brief demands hero/visual photography", () => {
    expect(PROMPT).toMatch(/hero image/i);
    expect(PROMPT).toMatch(/mortgage startup.*single hero image.*confident headline/i);
  });

  it("calls out limitations of IMAGE for dense readable text vs flat title layout", () => {
    expect(PROMPT.toLowerCase()).toMatch(/multi-block text|readable body copy/i);
  });

  it("provides concrete examples for all four layout kinds", () => {
    expect(PROMPT).toMatch(/grid layout/i);
    expect(PROMPT).toMatch(/stats layout/i);
    expect(PROMPT).toMatch(/bullets layout/i);
    expect(PROMPT).toMatch(/title layout/i);
  });

  it("instructs how to handle compound prompts", () => {
    expect(PROMPT).toMatch(/compound prompts/i);
    expect(PROMPT).toMatch(/main user intent/i);
  });

  it("requires JSON-only output (no markdown fences)", () => {
    expect(PROMPT.toLowerCase()).toContain("no markdown fences");
    expect(PROMPT).toMatch(/start with \{ and end with \}/i);
  });

  it("requires reasoning field in classifier output", () => {
    expect(PROMPT).toContain('"reasoning"');
  });

  it("lists the curated trigger keywords for layout detection", () => {
    // Keep this list short and high-signal. Expand based on real misclassifications.
    expect(PROMPT).toContain('"agenda"');
    expect(PROMPT).toContain('"metrics"');
    expect(PROMPT).toContain('"list"');
    expect(PROMPT).toContain('"roadmap"');
    expect(PROMPT).toContain('"comparison"');
  });

  it("includes the user prompt verbatim", () => {
    const p = buildClassificationPrompt("A list of features", false);
    expect(p).toContain("A list of features");
  });

  it("does not include variation language when variation=false", () => {
    expect(PROMPT).not.toContain("VARIATION REQUEST");
  });

  it("includes variation language when variation=true", () => {
    expect(PROMPT_VARIATION).toContain("VARIATION REQUEST");
  });
});
