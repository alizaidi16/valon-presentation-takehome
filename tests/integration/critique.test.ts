/**
 * Integration tests for POST /api/critique.
 *
 * GoogleGenAI is mocked. Tests cover validation, multimodal payload assembly,
 * normalization (lenient field handling), and error surfacing.
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

import { POST } from "../../app/api/critique/route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/critique", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function textResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const validCritique = {
  overall: "needs-work",
  summary: "Headline buries the lede; image is generic.",
  strengths: ["Strong color palette", "Clean composition"],
  issues: [
    {
      severity: "high",
      area: "message",
      message: "Headline 'Our Approach' is vague.",
      suggestion: "Replace with a concrete claim like 'Cut reconciliation time 80%.'"
    },
    {
      severity: "low",
      area: "visual",
      message: "Logo placement competes with the headline.",
      suggestion: "Move logo to the bottom-right corner at 60% opacity."
    }
  ]
};

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
  mockGenerateContent.mockReset();
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
});

describe("POST /api/critique — validation", () => {
  it("rejects missing prompt", async () => {
    const res = await POST(makeRequest({ kind: "image", imageData: "data:image/png;base64,abc" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/prompt/i);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("rejects image kind without imageData", async () => {
    const res = await POST(makeRequest({ prompt: "test", kind: "image" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/imageData required/i);
  });

  it("rejects layout kind without layout content", async () => {
    const res = await POST(makeRequest({ prompt: "test", kind: "layout" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/layout required/i);
  });
});

describe("POST /api/critique — multimodal payload", () => {
  it("sends the image as inlineData when kind is image", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validCritique)));

    const res = await POST(
      makeRequest({
        prompt: "A bold hero shot",
        kind: "image",
        imageData: "data:image/png;base64,AAAA"
      })
    );

    expect(res.status).toBe(200);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(Array.isArray(call.contents)).toBe(true);
    const contents = call.contents as Array<Record<string, unknown>>;
    const imagePart = contents.find((c) => "inlineData" in c) as
      | { inlineData: { mimeType: string; data: string } }
      | undefined;
    expect(imagePart).toBeDefined();
    expect(imagePart?.inlineData.mimeType).toBe("image/png");
    expect(imagePart?.inlineData.data).toBe("AAAA");
  });

  it("sends just text when kind is layout", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validCritique)));

    const res = await POST(
      makeRequest({
        prompt: "Three product pillars",
        kind: "layout",
        layout: {
          kind: "grid",
          headline: "Our Pillars",
          items: [{ title: "Speed", body: "Fast." }]
        }
      })
    );

    expect(res.status).toBe(200);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(typeof call.contents).toBe("string");
    expect(call.contents).toContain("Three product pillars");
    expect(call.contents).toContain('"kind": "grid"');
  });

  it("falls back to text-only if image data URL is malformed", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validCritique)));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "image",
        imageData: "not-a-data-url"
      })
    );

    expect(res.status).toBe(200);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(typeof call.contents).toBe("string");
  });
});

describe("POST /api/critique — response normalization", () => {
  it("returns the parsed critique when shape is valid", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validCritique)));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "layout",
        layout: { kind: "title", headline: "Hi" }
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("needs-work");
    expect(body.summary).toMatch(/buries the lede/);
    expect(body.strengths).toHaveLength(2);
    expect(body.issues).toHaveLength(2);
    expect(body.issues[0].severity).toBe("high");
  });

  it("strips invalid issues and caps strengths/issues at 5", async () => {
    const noisy = {
      overall: "good",
      summary: "OK.",
      strengths: ["a", "b", "c", "d", "e", "f", 123, null], // 6 valid + 2 garbage
      issues: [
        { severity: "high", area: "message", message: "ok", suggestion: "fix" },
        { severity: "weird", area: "visual", message: "still ok", suggestion: "fix" }, // bad severity → defaults to medium
        { severity: "low", area: "made-up", message: "still ok 2", suggestion: "fix" }, // bad area → defaults to message
        { message: "" }, // dropped (no message)
        null, // dropped
        { severity: "low", area: "message", message: "5", suggestion: "5" },
        { severity: "low", area: "message", message: "6", suggestion: "6" },
        { severity: "low", area: "message", message: "7", suggestion: "7" }
      ]
    };
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(noisy)));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "layout",
        layout: { kind: "title", headline: "Hi" }
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strengths).toHaveLength(5);
    expect(body.issues).toHaveLength(5);
    expect(body.issues[1].severity).toBe("medium"); // normalized
    expect(body.issues[2].area).toBe("message"); // normalized
  });

  it("defaults overall to 'good' when missing", async () => {
    const partial = {
      summary: "Reasonable slide.",
      strengths: [],
      issues: [{ severity: "low", area: "message", message: "tiny nit", suggestion: "fix" }]
    };
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(partial)));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "layout",
        layout: { kind: "title", headline: "Hi" }
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("good");
  });
});

describe("POST /api/critique — failure surfacing", () => {
  it("returns 502 with raw output when JSON parse fails", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("definitely not json"));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "layout",
        layout: { kind: "title", headline: "Hi" }
      })
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/critique failed/i);
    expect(body.error).toMatch(/definitely not json/);
  });

  it("returns 502 when shape is invalid (no summary)", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify({ overall: "good" })));

    const res = await POST(
      makeRequest({
        prompt: "test",
        kind: "layout",
        layout: { kind: "title", headline: "Hi" }
      })
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/shape invalid/i);
  });
});
