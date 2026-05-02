/**
 * Integration tests for POST /api/extract-style.
 *
 * GoogleGenAI is mocked. Tests cover input validation, multimodal payload
 * assembly (image is sent as inlineData), DNA normalization (lenient hex
 * handling), and failure modes.
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

import { POST } from "../../app/api/extract-style/route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/extract-style", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function textResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const validDNA = {
  palette: { paper: "#fffaf0", ink: "#1f160f", accent: "#b8553a" },
  mood: "editorial",
  imagePromptAppendix:
    "Editorial illustration aesthetic. Warm cream background, deep ink foreground, terracotta accent. Generous negative space, single focal subject."
};

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
  mockGenerateContent.mockReset();
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
});

describe("POST /api/extract-style — validation", () => {
  it("rejects missing imageData", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("rejects malformed data URL", async () => {
    const res = await POST(makeRequest({ imageData: "https://example.com/img.png" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/data url/i);
  });
});

describe("POST /api/extract-style — multimodal payload", () => {
  it("sends the image as inlineData", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validDNA)));

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(200);
    const call = mockGenerateContent.mock.calls[0][0];
    const contents = call.contents as Array<Record<string, unknown>>;
    expect(Array.isArray(contents)).toBe(true);
    const imagePart = contents.find((c) => "inlineData" in c) as
      | { inlineData: { mimeType: string; data: string } }
      | undefined;
    expect(imagePart?.inlineData.mimeType).toBe("image/png");
    expect(imagePart?.inlineData.data).toBe("XYZW");
  });
});

describe("POST /api/extract-style — DNA normalization", () => {
  it("returns the parsed DNA when shape is valid", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse(JSON.stringify(validDNA)));

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.palette.paper).toBe("#fffaf0");
    expect(body.palette.ink).toBe("#1f160f");
    expect(body.palette.accent).toBe("#b8553a");
    expect(body.mood).toBe("editorial");
    expect(body.imagePromptAppendix).toMatch(/cream/i);
  });

  it("normalizes 3-char hex into 6-char form", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          palette: { paper: "#fff", ink: "#000", accent: "#f0a" },
          mood: "monochrome",
          imagePromptAppendix: "x".repeat(40)
        })
      )
    );

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.palette.paper).toBe("#ffffff");
    expect(body.palette.ink).toBe("#000000");
    expect(body.palette.accent).toBe("#ff00aa");
  });

  it("falls back accent to ink when accent is missing/invalid", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          palette: { paper: "#fff", ink: "#000", accent: "garbage" },
          mood: "x",
          imagePromptAppendix: "x".repeat(40)
        })
      )
    );

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.palette.accent).toBe("#000000"); // ink
  });

  it("defaults mood to 'custom' when missing", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          palette: { paper: "#fff", ink: "#000", accent: "#abc" },
          imagePromptAppendix: "x".repeat(40)
        })
      )
    );

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mood).toBe("custom");
  });

  it("502s when palette is missing", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(JSON.stringify({ mood: "x", imagePromptAppendix: "x".repeat(40) }))
    );

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(502);
  });

  it("502s when imagePromptAppendix is too short", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          palette: { paper: "#fff", ink: "#000", accent: "#abc" },
          imagePromptAppendix: "too short"
        })
      )
    );

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(502);
  });
});

describe("POST /api/extract-style — failure surfacing", () => {
  it("502s on bad JSON with raw output preview", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("not json at all"));

    const res = await POST(makeRequest({ imageData: "data:image/png;base64,XYZW" }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/style extraction failed/i);
    expect(body.error).toMatch(/not json at all/);
  });
});
