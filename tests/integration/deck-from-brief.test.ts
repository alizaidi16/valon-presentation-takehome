/**
 * Integration tests for POST /api/deck-from-brief
 *
 * GoogleGenAI is mocked. Tests cover validation, parsing, normalization,
 * and error handling for the deck outline generator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn()
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  }
}));

import { POST } from "../../app/api/deck-from-brief/route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/deck-from-brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function textResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const validOutline = {
  deckTitle: "Acme Pitch",
  slides: [
    {
      name: "Title",
      prompt: "Hero opening for Acme Inc — bold typography, our logo prominently displayed.",
      suggestedFormat: "image",
      notes: "Take a beat. Welcome the room."
    },
    {
      name: "The Problem",
      prompt: "SMBs lose 12 hours/week reconciling expense reports manually.",
      suggestedFormat: "stats",
      notes: "Anchor the pain. Don't oversell."
    },
    {
      name: "Our Solution",
      prompt: "Three core capabilities: instant capture, auto-categorization, one-click approval.",
      suggestedFormat: "grid",
      notes: "Walk through left to right."
    }
  ]
};

// ── Error cases ─────────────────────────────────────────────────────────────

describe("POST /api/deck-from-brief — error handling", () => {
  const originalKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.GOOGLE_API_KEY = originalKey;
  });

  it("returns 500 when GOOGLE_API_KEY is missing", async () => {
    delete process.env.GOOGLE_API_KEY;
    const res = await POST(makeRequest({ brief: "A pitch deck for our SaaS" }));
    expect(res.status).toBe(500);
  });

  it("returns 400 when brief is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when brief is too short", async () => {
    const res = await POST(makeRequest({ brief: "hi" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too short/i);
  });

  it("returns 400 when brief is empty string", async () => {
    const res = await POST(makeRequest({ brief: "   " }));
    expect(res.status).toBe(400);
  });
});

// ── Successful generation ────────────────────────────────────────────────────

describe("POST /api/deck-from-brief — happy path", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("returns the parsed outline when model returns valid JSON", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validOutline)));

    const res = await POST(
      makeRequest({ brief: "Pitch deck for our B2B expense automation startup." })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof validOutline;
    expect(body.deckTitle).toBe("Acme Pitch");
    expect(body.slides).toHaveLength(3);
    expect(body.slides[0].name).toBe("Title");
    expect(body.slides[1].suggestedFormat).toBe("stats");
  });

  it("strips markdown fences from model output", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse("```json\n" + JSON.stringify(validOutline) + "\n```")
    );

    const res = await POST(
      makeRequest({ brief: "Pitch deck for our B2B expense automation startup." })
    );
    expect(res.status).toBe(200);
  });

  it("normalizes invalid suggestedFormat values to 'auto'", async () => {
    const outlineWithBadFormat = {
      ...validOutline,
      slides: [
        {
          name: "Bad",
          prompt: "Some prompt that is long enough",
          suggestedFormat: "carousel-of-fire", // invalid
          notes: "x"
        }
      ]
    };
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(outlineWithBadFormat)));

    const res = await POST(
      makeRequest({ brief: "A normal brief for the test." })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof validOutline;
    expect(body.slides[0].suggestedFormat).toBe("auto");
  });

  it("defaults notes to empty string when missing", async () => {
    const outlineNoNotes = {
      deckTitle: "X",
      slides: [{ name: "S", prompt: "A prompt long enough", suggestedFormat: "title" }]
    };
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(outlineNoNotes)));

    const res = await POST(
      makeRequest({ brief: "Some brief that is long enough." })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof validOutline;
    expect(body.slides[0].notes).toBe("");
  });

  it("forwards slideCount to the model prompt", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validOutline)));

    await POST(
      makeRequest({ brief: "Some brief for testing.", slideCount: 5 })
    );

    const promptArg = mockGenerateContent.mock.calls[0][0].contents as string;
    expect(promptArg).toContain("exactly 5 slides");
  });

  it("clamps slideCount to a sensible range", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validOutline)));

    // 999 should be ignored (out of range), so the model gets 'decide' instructions
    await POST(makeRequest({ brief: "Some brief for testing.", slideCount: 999 }));

    const promptArg = mockGenerateContent.mock.calls[0][0].contents as string;
    expect(promptArg).not.toContain("exactly 999");
    expect(promptArg).toContain("Decide the right number");
  });

  it("ignores negative slideCount and lets the AI decide", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validOutline)));

    await POST(makeRequest({ brief: "Some brief for testing.", slideCount: -3 }));

    const promptArg = mockGenerateContent.mock.calls[0][0].contents as string;
    expect(promptArg).toContain("Decide the right number");
  });
});

// ── Failure modes surface, don't hide ───────────────────────────────────────

describe("POST /api/deck-from-brief — failure surfacing", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("returns 502 with debug info when model returns invalid JSON", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("this is not json"));

    const res = await POST(makeRequest({ brief: "A normal brief for the test." }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/outline generation failed/i);
    expect(body.error).toContain("this is not json");
  });

  it("returns 502 when model returns valid JSON but wrong shape", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ deckTitle: "X" })) // missing slides array
    );

    const res = await POST(makeRequest({ brief: "A normal brief for the test." }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/shape invalid/i);
  });

  it("returns 502 when slides array is empty", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ deckTitle: "Empty", slides: [] }))
    );

    const res = await POST(makeRequest({ brief: "A normal brief for the test." }));
    expect(res.status).toBe(502);
  });

  it("returns 502 when model throws", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("Network down"));

    const res = await POST(makeRequest({ brief: "A normal brief for the test." }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Network down");
  });
});
