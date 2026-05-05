/**
 * Unit tests for lib/ai/helpers — pure utility functions, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  extractImage,
  extractText,
  extractFirstJsonObject,
  normalizeFormat,
  parseDataUrl,
  parseModelJson,
  stripFences,
  VALID_FORMATS
} from "../../lib/ai/helpers";

describe("stripFences", () => {
  it("removes ```json fences", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("removes plain ``` fences", () => {
    expect(stripFences("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("handles uppercase JSON tag", () => {
    expect(stripFences("```JSON\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("leaves unfenced text alone", () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });

  it("trims whitespace", () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("handles missing closing fence", () => {
    // Real models occasionally truncate — should still strip the opener
    expect(stripFences("```json\n{\"a\":1}")).toBe('{"a":1}');
  });
});

describe("extractFirstJsonObject", () => {
  it("isolates object when prose follows complete JSON", () => {
    expect(extractFirstJsonObject('{"type":"layout"} Here is extra')).toBe('{"type":"layout"}');
  });

  it("handles nested structures", () => {
    expect(
      extractFirstJsonObject('prefix {"layout":{"kind":"title"},"ok":true}suffix')
    ).toBe('{"layout":{"kind":"title"},"ok":true}');
  });

  it("does not treat braces inside strings as structure", () => {
    expect(
      extractFirstJsonObject('{"msg":"literal {braces} inside","z":1}trailing')
    ).toBe('{"msg":"literal {braces} inside","z":1}');
  });

  it("returns null when there is no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });
});

describe("parseModelJson", () => {
  it("strips fences when response ends with closing fence", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses first object only when prose follows unfenced JSON", () => {
    expect(parseModelJson('{"a":1}\nMore text')).toEqual({ a: 1 });
  });

  it("parses whole string when no trailing junk", () => {
    expect(parseModelJson('{"b":2}')).toEqual({ b: 2 });
  });
});

describe("extractText", () => {
  it("concatenates all text parts across candidates", () => {
    const response = {
      candidates: [
        { content: { parts: [{ text: "Hello " }, { text: "world" }] } },
        { content: { parts: [{ text: "!" }] } }
      ]
    };
    expect(extractText(response)).toBe("Hello world!");
  });

  it("ignores non-text parts (e.g. images)", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [{ text: "Caption" }, { inlineData: { mimeType: "image/png", data: "x" } }]
          }
        }
      ]
    };
    expect(extractText(response)).toBe("Caption");
  });

  it("returns empty string for empty response", () => {
    expect(extractText({})).toBe("");
    expect(extractText({ candidates: [] })).toBe("");
  });
});

describe("extractImage", () => {
  it("returns mimeType and data when present", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { text: "here" },
              { inlineData: { mimeType: "image/png", data: "abc123" } }
            ]
          }
        }
      ]
    };
    expect(extractImage(response)).toEqual({ mimeType: "image/png", data: "abc123" });
  });

  it("returns null when no image part", () => {
    const response = {
      candidates: [{ content: { parts: [{ text: "no image here" }] } }]
    };
    expect(extractImage(response)).toBeNull();
  });

  it("returns null on missing data field", () => {
    const response = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png" } }] } }
      ]
    };
    expect(extractImage(response)).toBeNull();
  });
});

describe("parseDataUrl", () => {
  it("parses image/png base64 data URLs", () => {
    expect(parseDataUrl("data:image/png;base64,abcd")).toEqual({
      mimeType: "image/png",
      data: "abcd"
    });
  });

  it("strips whitespace in base64 payload", () => {
    expect(parseDataUrl("data:image/jpeg;base64,ab\ncd")).toEqual({
      mimeType: "image/jpeg",
      data: "abcd"
    });
  });

  it("returns null when not base64", () => {
    expect(parseDataUrl("data:image/png,plain")).toBeNull();
  });

  it("returns null on non-data URL", () => {
    expect(parseDataUrl("https://example.com/x")).toBeNull();
  });
});

describe("normalizeFormat", () => {
  it("accepts all valid formats", () => {
    for (const format of VALID_FORMATS) {
      expect(normalizeFormat(format)).toBe(format);
    }
  });

  it("falls back to 'auto' on unknown string", () => {
    expect(normalizeFormat("carousel")).toBe("auto");
    expect(normalizeFormat("IMAGE")).toBe("auto"); // case-sensitive
  });

  it("falls back to 'auto' on non-string", () => {
    expect(normalizeFormat(null)).toBe("auto");
    expect(normalizeFormat(undefined)).toBe("auto");
    expect(normalizeFormat(123)).toBe("auto");
    expect(normalizeFormat({})).toBe("auto");
  });
});
