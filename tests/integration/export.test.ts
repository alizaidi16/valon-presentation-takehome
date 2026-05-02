/**
 * Integration tests for POST /api/export
 *
 * These tests import the route handler directly — no running server needed.
 * pptxgenjs runs as pure Node.js so no mocking is required.
 */

import { describe, it, expect } from "vitest";
import { POST } from "../../app/api/export/route";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function expectValidPptx(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain(PPTX_MIME);

  const buf = await res.arrayBuffer();
  expect(buf.byteLength).toBeGreaterThan(2000);

  // PPTX is a ZIP file — verify the PK magic bytes
  const bytes = new Uint8Array(buf);
  expect(bytes[0]).toBe(0x50); // P
  expect(bytes[1]).toBe(0x4b); // K
}

// ── Error cases ─────────────────────────────────────────────────────────────

describe("POST /api/export — error handling", () => {
  it("returns 400 when slides is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no slides/i);
  });

  it("returns 400 when slides is an empty array", async () => {
    const res = await POST(makeRequest({ slides: [] }));
    expect(res.status).toBe(400);
  });
});

// ── Layout types ─────────────────────────────────────────────────────────────

describe("POST /api/export — layout slide types", () => {
  it("exports a title layout slide", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Title",
            prompt: "Opening slide",
            kind: "layout",
            layout: { kind: "title", headline: "Hello World", subtitle: "A subtitle" }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a title layout without a subtitle", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Title",
            prompt: "p",
            kind: "layout",
            layout: { kind: "title", headline: "Just a headline" }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a bullets layout slide", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Bullets",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "bullets",
              headline: "Why us",
              bullets: ["Fast", "Cheap", "Good — pick all three"]
            }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a grid layout with 2 items", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Grid 2",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "grid",
              headline: "Our pillars",
              items: [
                { title: "Speed", body: "Same-day closings." },
                { title: "Trust", body: "98% satisfaction." }
              ]
            }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a grid layout with 4 items", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Grid 4",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "grid",
              headline: "Features",
              items: [
                { title: "A", body: "Alpha" },
                { title: "B", body: "Beta" },
                { title: "C", body: "Gamma" },
                { title: "D", body: "Delta" }
              ]
            }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a stats layout with headline", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Stats",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "stats",
              headline: "By the numbers",
              stats: [
                { value: "99%", label: "Uptime" },
                { value: "$2B", label: "Loans closed" },
                { value: "50", label: "States served" }
              ]
            }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a stats layout without a headline", async () => {
    const res = await POST(
      makeRequest({
        slides: [
          {
            name: "Stats headless",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "stats",
              stats: [
                { value: "94%", label: "CSAT" },
                { value: "3 days", label: "Avg close" }
              ]
            }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });
});

// ── Mixed decks ───────────────────────────────────────────────────────────────

describe("POST /api/export — mixed decks", () => {
  it("exports a deck with all four layout types", async () => {
    const res = await POST(
      makeRequest({
        title: "Full layout deck",
        slides: [
          {
            name: "Title",
            prompt: "p",
            kind: "layout",
            layout: { kind: "title", headline: "Hello", subtitle: "World" }
          },
          {
            name: "Bullets",
            prompt: "p",
            kind: "layout",
            layout: { kind: "bullets", headline: "Points", bullets: ["One", "Two"] }
          },
          {
            name: "Grid",
            prompt: "p",
            kind: "layout",
            layout: {
              kind: "grid",
              headline: "Grid",
              items: [{ title: "A", body: "a" }, { title: "B", body: "b" }]
            }
          },
          {
            name: "Stats",
            prompt: "p",
            kind: "layout",
            layout: { kind: "stats", stats: [{ value: "1M", label: "users" }] }
          }
        ]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a deck with a placeholder slide (no image, no layout)", async () => {
    const res = await POST(
      makeRequest({
        slides: [{ name: "Empty", prompt: "Some prompt" }]
      })
    );
    await expectValidPptx(res);
  });

  it("exports a single-slide deck with kind=image but no imageData (placeholder path)", async () => {
    const res = await POST(
      makeRequest({
        slides: [{ name: "Img missing", prompt: "p", kind: "image" }]
      })
    );
    // Should still produce a valid PPTX with the placeholder rect
    await expectValidPptx(res);
  });
});
