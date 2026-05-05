/**
 * Share-hash helpers — deflate + base64url round-trip requires CompressionStream
 * (Node 18+, modern browsers).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../../lib/ai/themes";
import { decodeDeckHash, encodeDeckHash, toSharePayload } from "../../lib/share/deck-url";

const hasCompression = typeof CompressionStream !== "undefined";

describe.skipIf(!hasCompression)("deck-url", () => {
  it("toSharePayload keeps structured slide fields only", () => {
    const slides = [
      {
        id: "slide-a",
        name: "Intro",
        prompt: "Hero skyline",
        note: "Say hello",
        suggestedFormat: "image",
        kind: "image",
        status: "done",
        feedback: "done",
        imageData: "data:image/png;base64,HUGE_SHOULD_NOT_APPEAR",
        critique: { overall: "good", strengths: [], issues: [], summary: "" },
        extraStuff: "junk"
      }
    ];

    const payload = toSharePayload({
      slides,
      selectedId: "slide-a",
      theme: DEFAULT_THEME
    });

    expect(payload.slides[0]?.prompt).toBe("Hero skyline");
    expect(payload.slides[0]?.feedback).toBe("done");
    expect(payload.theme.imagePromptAppendix).toMatch(/fintech|cream|Valon/i);
    expect("imageData" in payload.slides[0]).toBe(false);
    expect("critique" in payload.slides[0]).toBe(false);
    expect("extraStuff" in payload.slides[0]).toBe(false);
  });

  it("encodeDeckHash and decodeDeckHash round-trip", async () => {
    const payload = toSharePayload({
      slides: [
        {
          id: "1",
          name: "Title",
          prompt: "Bold headline",
          note: "smile",
          suggestedFormat: "title",
          kind: "layout",
          layout: { kind: "title", headline: "Hi" }
        }
      ],
      selectedId: "1",
      theme: DEFAULT_THEME
    });

    const enc = await encodeDeckHash(payload);
    expect(typeof enc).toBe("string");

    const dec = await decodeDeckHash(enc as string);
    expect(dec).not.toBeNull();
    expect(dec?.v).toBe(1);
    expect(dec?.selectedId).toBe("1");
    expect(dec?.slides[0]?.layout).toEqual({ kind: "title", headline: "Hi" });
    expect(dec?.theme.id).toBe(DEFAULT_THEME.id);
  });
});
