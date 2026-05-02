/**
 * Unit tests for lib/ai/helpers — pure utility functions, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  extractImage,
  extractText,
  normalizeFormat,
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
