#!/usr/bin/env node
/**
 * End-to-end smoke tests against a running dev server.
 *
 * Usage:
 *   npm run test:smoke                    (assumes http://localhost:3000)
 *   BASE_URL=http://localhost:3001 npm run test:smoke
 *
 * Tests that hit /api/generate with a real AI call are skipped unless
 * GOOGLE_API_KEY is set in the environment.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function postJson(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ── Connectivity ──────────────────────────────────────────────────────────────

console.log(`\nSmoke tests → ${BASE}\n`);
console.log("── Connectivity ──────────────────────────────────");

await test("server is reachable", async () => {
  const res = await fetch(BASE).catch(() => null);
  assert(res !== null, "Could not reach server — is `npm run dev` running?");
});

// ── /api/export error cases ───────────────────────────────────────────────────

console.log("\n── /api/export — error cases ─────────────────────");

await test("returns 400 on empty body", async () => {
  const res = await postJson("/api/export", {});
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  const body = await res.json();
  assert(body.error, "Expected an error message");
});

await test("returns 400 on empty slides array", async () => {
  const res = await postJson("/api/export", { slides: [] });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

// ── /api/export layout slides ─────────────────────────────────────────────────

console.log("\n── /api/export — layout slides ───────────────────");

const LAYOUT_DECK = {
  title: "Smoke Test Deck",
  slides: [
    {
      name: "Title slide",
      prompt: "p",
      kind: "layout",
      layout: { kind: "title", headline: "Hello World", subtitle: "Smoke test subtitle" }
    },
    {
      name: "Bullets slide",
      prompt: "p",
      kind: "layout",
      layout: {
        kind: "bullets",
        headline: "Key Points",
        bullets: ["First bullet", "Second bullet", "Third bullet"]
      }
    },
    {
      name: "Grid slide",
      prompt: "p",
      kind: "layout",
      layout: {
        kind: "grid",
        headline: "Our Features",
        items: [
          { title: "Speed", body: "Fast closings." },
          { title: "Trust", body: "98% CSAT." },
          { title: "Scale", body: "All 50 states." }
        ]
      }
    },
    {
      name: "Stats slide",
      prompt: "p",
      kind: "layout",
      layout: {
        kind: "stats",
        headline: "By the Numbers",
        stats: [
          { value: "$4B", label: "Loans originated" },
          { value: "99%", label: "Uptime" },
          { value: "3 days", label: "Avg close time" }
        ]
      }
    }
  ]
};

await test("exports a 4-slide layout deck (200 + PPTX content-type)", async () => {
  const res = await postJson("/api/export", LAYOUT_DECK);
  assert(res.ok, `Expected 200, got ${res.status}: ${await res.text()}`);
  const ct = res.headers.get("content-type") ?? "";
  assert(ct.includes("presentationml"), `Wrong content-type: ${ct}`);
});

await test("PPTX binary has valid ZIP magic bytes (PK)", async () => {
  const res = await postJson("/api/export", LAYOUT_DECK);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "File does not start with PK — not a valid ZIP/PPTX");
});

await test("PPTX binary is larger than 5 KB", async () => {
  const res = await postJson("/api/export", LAYOUT_DECK);
  const buf = await res.arrayBuffer();
  assert(buf.byteLength > 5000, `PPTX too small: ${buf.byteLength} bytes`);
});

await test("exports a placeholder slide (no image, no layout)", async () => {
  const res = await postJson("/api/export", {
    slides: [{ name: "Empty", prompt: "A prompt with no content yet" }]
  });
  assert(res.ok, `Expected 200, got ${res.status}`);
});

// ── /api/deck-from-brief error cases ──────────────────────────────────────────

console.log("\n── /api/deck-from-brief — error cases ────────────");

await test("returns 400 on missing brief", async () => {
  const res = await postJson("/api/deck-from-brief", {});
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

await test("returns 400 when brief is too short", async () => {
  const res = await postJson("/api/deck-from-brief", { brief: "hi" });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

if (process.env.GOOGLE_API_KEY) {
  console.log("\n── /api/deck-from-brief — live AI ────────────────");

  await test("generates a valid deck outline from a real brief", async () => {
    const res = await postJson("/api/deck-from-brief", {
      brief:
        "5-slide pitch for a B2B SaaS that automates expense reports for SMBs. Audience: seed VCs.",
      slideCount: 5
    });
    assert(res.ok, `Expected 200, got ${res.status}: ${await res.text()}`);

    const body = await res.json();
    assert(typeof body.deckTitle === "string", "Missing deckTitle");
    assert(Array.isArray(body.slides), "slides must be an array");
    assert(body.slides.length >= 3, `Expected at least 3 slides, got ${body.slides.length}`);

    for (const slide of body.slides) {
      assert(typeof slide.name === "string", "Slide name must be string");
      assert(typeof slide.prompt === "string", "Slide prompt must be string");
      assert(
        ["auto", "image", "title", "bullets", "grid", "stats"].includes(slide.suggestedFormat),
        `Invalid suggestedFormat: ${slide.suggestedFormat}`
      );
      assert(typeof slide.notes === "string", "Slide notes must be string");
    }
  });
}

// ── /api/generate error cases ─────────────────────────────────────────────────

console.log("\n── /api/generate — error cases ───────────────────");

await test("returns 400 on missing prompt", async () => {
  const res = await postJson("/api/generate", {});
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

await test("returns 400 on empty prompt string", async () => {
  const res = await postJson("/api/generate", { prompt: "   " });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

// ── /api/critique error cases ─────────────────────────────────────────────────

console.log("\n── /api/critique — error cases ───────────────────");

await test("returns 400 on missing prompt", async () => {
  const res = await postJson("/api/critique", { kind: "layout", layout: { kind: "title", headline: "x" } });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

await test("returns 400 when kind is image but no imageData", async () => {
  const res = await postJson("/api/critique", { prompt: "test", kind: "image" });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
});

if (process.env.GOOGLE_API_KEY) {
  console.log("\n── /api/critique — live AI ───────────────────────");

  await test("critiques a layout slide and returns shaped JSON", async () => {
    const res = await postJson("/api/critique", {
      prompt: "Three product pillars",
      name: "Pillars",
      kind: "layout",
      layout: {
        kind: "grid",
        headline: "Our Pillars",
        items: [
          { title: "Speed", body: "Fast." },
          { title: "Trust", body: "Always." },
          { title: "Simplicity", body: "Clean." }
        ]
      }
    });
    assert(res.ok, `Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    assert(["strong", "good", "needs-work", "weak"].includes(body.overall), `Unexpected overall: ${body.overall}`);
    assert(typeof body.summary === "string" && body.summary.length > 0, "Missing summary");
    assert(Array.isArray(body.strengths), "strengths must be array");
    assert(Array.isArray(body.issues), "issues must be array");
  });
}

// ── /api/generate live AI tests (requires GOOGLE_API_KEY) ────────────────────

if (process.env.GOOGLE_API_KEY) {
  console.log("\n── /api/generate — live AI (GOOGLE_API_KEY detected) ─");

  await test("layout-leaning prompt returns valid {kind, layout} response", async () => {
    const res = await postJson("/api/generate", {
      prompt: "Three bullet points about why customers love us",
      variation: false
    });
    assert(res.ok, `Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    assert(["image", "layout"].includes(body.kind), `Unexpected kind: ${body.kind}`);
    if (body.kind === "layout") {
      assert(body.layout && typeof body.layout.kind === "string", "Missing layout.kind");
      assert(
        ["title", "bullets", "grid", "stats"].includes(body.layout.kind),
        `Unknown layout kind: ${body.layout.kind}`
      );
    }
    if (body.kind === "image") {
      assert(body.imageData?.startsWith("data:"), "imageData must be a data URL");
    }
  });

  await test("image-leaning prompt returns valid {kind, imageData} response", async () => {
    const res = await postJson("/api/generate", {
      prompt: "A dramatic hero image of a house with a sold sign at sunset",
      variation: false
    });
    assert(res.ok, `Expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    assert(["image", "layout"].includes(body.kind), `Unexpected kind: ${body.kind}`);
  });

  await test("variation=true returns a valid response", async () => {
    const res = await postJson("/api/generate", {
      prompt: "Statistics about our loan volume",
      variation: true
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(["image", "layout"].includes(body.kind), `Unexpected kind: ${body.kind}`);
  });
} else {
  console.log("\n── /api/generate — live AI ───────────────────────");
  console.log("  ⚠ Skipped (set GOOGLE_API_KEY to run live AI tests)");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
