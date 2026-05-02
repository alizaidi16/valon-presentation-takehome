/**
 * Integration tests for POST /api/generate
 *
 * GoogleGenAI is mocked so no real API key or network is needed.
 * We test the routing logic: classification → layout return, or
 * classification → image model call → image return.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks must be declared before the route import ──────────────────────────
// vi.hoisted ensures mockGenerateContent is available inside the factory AND
// in test bodies, even though vi.mock() is hoisted to the top of the file.

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn()
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  }
}));

import { POST } from "../../app/api/generate/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function textResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }]
  };
}

function imageResponse(mimeType = "image/png", data = "base64encodeddata") {
  return {
    candidates: [
      {
        content: {
          parts: [
            { text: "Here is your image." },
            { inlineData: { mimeType, data } }
          ]
        }
      }
    ]
  };
}

// ── Error cases ───────────────────────────────────────────────────────────────

describe("POST /api/generate — error handling", () => {
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
    const res = await POST(makeRequest({ prompt: "hello" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GOOGLE_API_KEY/i);
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when prompt is an empty string", async () => {
    const res = await POST(makeRequest({ prompt: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 502 when image model returns no image part", async () => {
    // Classifier says image, image model returns only text
    mockGenerateContent
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ type: "image", imagePrompt: "a house" }))
      )
      .mockResolvedValueOnce(textResponse("Sorry, I cannot generate that."));

    const res = await POST(makeRequest({ prompt: "A house" }));
    expect(res.status).toBe(502);
  });
});

// ── Classification → layout path ─────────────────────────────────────────────

describe("POST /api/generate — layout classification", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("returns a bullets layout when classifier returns bullets", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          reasoning: "list of reasons",
          layout: {
            kind: "bullets",
            headline: "Why choose us",
            bullets: ["Fast", "Affordable", "Reliable"]
          }
        })
      )
    );

    const res = await POST(makeRequest({ prompt: "Three reasons to choose us" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      reasoning?: string;
      layout: { kind: string; headline: string; bullets: string[] };
    };
    expect(body.kind).toBe("layout");
    expect(body.layout.kind).toBe("bullets");
    expect(body.layout.headline).toBe("Why choose us");
    expect(body.layout.bullets).toHaveLength(3);
    expect(body.reasoning).toBe("list of reasons");

    // Layout path must NOT call the image model
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("returns a title layout", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          layout: { kind: "title", headline: "Welcome to Valon", subtitle: "Home loans, simplified" }
        })
      )
    );

    const res = await POST(makeRequest({ prompt: "Title slide for our company" }));
    const body = (await res.json()) as { kind: string; layout: { kind: string } };
    expect(body.kind).toBe("layout");
    expect(body.layout.kind).toBe("title");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("returns a grid layout", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          layout: {
            kind: "grid",
            headline: "Our products",
            items: [
              { title: "Purchase", body: "Buy your dream home." },
              { title: "Refi", body: "Lower your rate." }
            ]
          }
        })
      )
    );

    const res = await POST(makeRequest({ prompt: "Our product lineup" }));
    const body = (await res.json()) as {
      kind: string;
      layout: { kind: string; items: unknown[] };
    };
    expect(body.kind).toBe("layout");
    expect(body.layout.kind).toBe("grid");
    expect(body.layout.items).toHaveLength(2);
  });

  it("returns a stats layout", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          layout: {
            kind: "stats",
            headline: "By the numbers",
            stats: [
              { value: "$4B", label: "Loans originated" },
              { value: "98%", label: "Customer satisfaction" }
            ]
          }
        })
      )
    );

    const res = await POST(makeRequest({ prompt: "Key metrics slide" }));
    const body = (await res.json()) as {
      kind: string;
      layout: { kind: string; stats: unknown[] };
    };
    expect(body.kind).toBe("layout");
    expect(body.layout.kind).toBe("stats");
    expect(body.layout.stats).toHaveLength(2);
  });

  it("strips markdown fences from classifier response", async () => {
    // Classifier wraps JSON in backticks (Haiku-style)
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        "```json\n" +
          JSON.stringify({ type: "layout", layout: { kind: "title", headline: "Fenced" } }) +
          "\n```"
      )
    );

    const res = await POST(makeRequest({ prompt: "Title" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("layout");
  });
});

// ── Classification → image path ───────────────────────────────────────────────

describe("POST /api/generate — image classification", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("returns an image when classifier routes to image", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({ type: "image", imagePrompt: "A dramatic mortgage hero shot" })
        )
      )
      .mockResolvedValueOnce(imageResponse("image/png", "abc123"));

    const res = await POST(makeRequest({ prompt: "A hero image for our pitch" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; imageData: string };
    expect(body.kind).toBe("image");
    expect(body.imageData).toBe("data:image/png;base64,abc123");

    // Both classifier AND image model were called
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("uses the refined imagePrompt from classifier (not the raw user prompt)", async () => {
    const refinedPrompt = "A dramatic wide-angle shot of a suburban house at golden hour";
    mockGenerateContent
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ type: "image", imagePrompt: refinedPrompt }))
      )
      .mockResolvedValueOnce(imageResponse());

    await POST(makeRequest({ prompt: "house" }));

    // Second call (image model) should contain the refined prompt in its contents
    const imageModelCall = mockGenerateContent.mock.calls[1];
    expect(imageModelCall[0].contents).toContain(refinedPrompt);
  });
});

// ── Classifier failure surfaces, doesn't silently fall back ─────────────────

describe("POST /api/generate — classifier failure modes", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("returns 502 with debug info when classifier returns invalid JSON", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse("this is not json at all, just a sentence")
    );

    const res = await POST(makeRequest({ prompt: "A house" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/classifier failed/i);
    // Surfaces the raw output so the user can see what went wrong
    expect(body.error).toContain("this is not json");
  });

  it("returns 502 with error detail when classifier throws", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("Network error"));

    const res = await POST(makeRequest({ prompt: "A house" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/classifier failed/i);
    expect(body.error).toContain("Network error");
  });
});

// ── Format override ───────────────────────────────────────────────────────────

describe("POST /api/generate — formatOverride", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("formatOverride='image' skips the classifier and goes straight to image model", async () => {
    mockGenerateContent.mockResolvedValueOnce(imageResponse("image/png", "xyz"));

    const res = await POST(
      makeRequest({ prompt: "Anything goes here", formatOverride: "image" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; imageData: string };
    expect(body.kind).toBe("image");
    expect(body.imageData).toBe("data:image/png;base64,xyz");

    // Only ONE call: the image model. No classifier call.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("formatOverride='grid' generates a grid layout directly", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          reasoning: "user forced grid",
          layout: {
            kind: "grid",
            headline: "Pillars",
            items: [
              { title: "A", body: "alpha" },
              { title: "B", body: "beta" }
            ]
          }
        })
      )
    );

    const res = await POST(
      makeRequest({ prompt: "Three product pillars", formatOverride: "grid" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; layout: { kind: string } };
    expect(body.kind).toBe("layout");
    expect(body.layout.kind).toBe("grid");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("formatOverride='stats' returns 502 when model produces unparseable output", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("not json"));

    const res = await POST(
      makeRequest({ prompt: "Some metrics", formatOverride: "stats" })
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/stats layout/i);
  });

  it("formatOverride='auto' is the same as omitting it (uses classifier)", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          type: "layout",
          layout: { kind: "title", headline: "Hello" }
        })
      )
    );

    const res = await POST(
      makeRequest({ prompt: "Title slide", formatOverride: "auto" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("layout");
  });
});

// ── Variation flag ────────────────────────────────────────────────────────────

describe("POST /api/generate — variation flag", () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  it("includes variation instruction in classifier prompt when variation=true", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ type: "layout", layout: { kind: "title", headline: "X" } }))
    );

    await POST(makeRequest({ prompt: "Some slide", variation: true }));

    const classifierPrompt = mockGenerateContent.mock.calls[0][0].contents as string;
    expect(classifierPrompt.toLowerCase()).toContain("variation");
  });

  it("does not include variation instruction when variation=false", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ type: "layout", layout: { kind: "title", headline: "X" } }))
    );

    await POST(makeRequest({ prompt: "Some slide", variation: false }));

    const classifierPrompt = mockGenerateContent.mock.calls[0][0].contents as string;
    // The word "variation" appears in the prompt template conditionally
    // When false, the variation line should not be present
    expect(classifierPrompt).not.toContain("try a noticeably different");
  });
});
