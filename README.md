# Slides but worse — a Valon take-home

> Type a brief. Get a deck. Pick the right format for every slide.

This is my submission for the Valon presentation take-home. The starter was an image-only slide builder; I rebuilt the generation pipeline to be **format-aware** and added a **deck-from-brief** flow. A reviewer reading this should expect ~80 tests to pass and a working app in under a minute of setup.

> **Demo:** drop a GIF here at `docs/screenshots/deck-from-brief.gif` showing the full flow — type brief → outline appears → cook a few slides → mixed-format deck.

---

## What's new vs the starter

The original starter would generate one image per slide. That's the wrong format for ~40% of slides — agendas, feature grids, stat callouts, comparison tables. Image models can't render legible body text, so a "key metrics" slide came back as a Comic Sans hallucination. The work below addresses that root problem and builds on top of it.

- **AI-routed format selection** — every prompt is classified before generation. Image vs `title` / `bullets` / `grid` / `stats`. Layout slides skip the image model entirely (~10x cheaper, ~5x faster).
- **Deck-from-brief** — input a paragraph (audience, purpose, tone) and get a full outline back: deck title, named slides, refined prompts, pre-set formats, and speaker notes. Click to open the brief overlay from the sidebar.
- **Per-slide format override** — chip selector lets you force any format if you disagree with the classifier. The chips are bound per-slide, so different slides remember their own choice.
- **Classifier reasoning surfaced in the UI** — the floating chip on the canvas shows *why* the AI picked the format it did. No more silent failures.
- **Real PPTX export for layout slides** — proper text layout, not "image overlay with placeholder rectangle." Each layout type has its own pptxgenjs renderer.
- **80-test test suite** — vitest for unit + integration, smoke script for end-to-end against a live dev server. No API key required for the offline tests.

---

## Run it

```bash
cp .env.example .env.local                    # add GOOGLE_API_KEY
npm install
npm run dev                                   # http://localhost:3000
```

Optional env vars:
- `GOOGLE_TEXT_MODEL` — defaults to `gemini-2.5-flash-lite` (purpose-built for classification at scale)
- `GOOGLE_IMAGE_MODEL` — defaults to `gemini-3-pro-image-preview`

## Test it

```bash
npm test                  # 80 unit + integration tests, no API key needed
npm run test:smoke        # end-to-end against http://localhost:3000
npm run typecheck         # strict TS, zero errors
```

The smoke script gracefully skips live AI tests when `GOOGLE_API_KEY` isn't set, so it doubles as a CI-friendly check that the routes are wired correctly.

---

## Architecture

Two AI flows, two routes, all logic in `lib/ai/`. Routes are thin HTTP adapters.

```
                    ┌─────────────────────────────────────────┐
                    │  Browser                                │
                    │  app/page.tsx (Zustand-free, just      │
                    │  React state + localStorage)            │
                    └────────────┬────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                                     ▼
   POST /api/generate                    POST /api/deck-from-brief
   { prompt, formatOverride }            { brief, slideCount? }
              │                                     │
              ▼                                     ▼
   ┌──────────────────────┐              ┌──────────────────────┐
   │ lib/ai/              │              │ lib/ai/              │
   │   generate-slide.ts  │              │   generate-outline.ts│
   └──────────┬───────────┘              └──────────┬───────────┘
              │                                     │
              ├─ formatOverride !== "auto"          │
              │  → skip classifier                  │
              │                                     │
              ├─ classifier (Gemini Flash-Lite)     │
              │  → returns { type: "image",         │
              │              "imagePrompt", ... }   │
              │    or { type: "layout", ... }       │
              │                                     │
              ├─ if image:                          │
              │   image model (Gemini 3 Pro Image)  │
              │   → base64 PNG                      │
              │                                     │
              └─ if layout:                         │
                 → return content directly,         │
                   no image call                    │
                                                    │
                                            outline (Gemini Flash-Lite)
                                            → { deckTitle, slides[] }
                                              with suggestedFormat
                                              pre-set per slide
```

**Why classify first?** Image models cannot render legible body text. Any slide with content the user is meant to *read* — not just look at — must be a layout. The classifier rules and examples live in `lib/ai/generate-slide.ts → buildClassificationPrompt`. The trigger keywords (`agenda`, `metrics`, `list`, `roadmap`, `comparison`) are intentionally short — pattern-matching on examples is more robust than long keyword lists.

**Why Gemini Flash-Lite?** Google specifically pitches it for *"high throughput tasks like classification or summarization at scale"* — exactly our workload. ~10x cheaper than Anthropic Haiku and noticeably faster. We don't need reasoning quality here; the classifier output is constrained JSON.

---

## Design decisions (and the alternatives I considered)

| Decision | Why |
|---|---|
| **Two-step pipeline (classify → dispatch)** | Lets us route layout slides away from the image model entirely. Tradeoff: one extra model call on the image path. Worth it because the saved layout calls dominate. |
| **Layout content lives in app state, not as image data** | Renders in real DOM (selectable, accessible, infinitely sharp). PPTX export builds real text frames, not screenshots. |
| **Per-slide `suggestedFormat` field** | Lets deck-from-brief pre-set each slide's format. The chips bind to whatever slide is selected. Cleaner than a global override. |
| **Fail loud on classifier errors** | Original code silently fell back to image, which produced the Comic Sans hallucination. Now: 502 with the raw model output in the error message — debuggable. |
| **`lib/ai/` separation** | Routes became 25 lines each. Lib functions are pure (input → output, no `Request`/`Response`). Tests can hit them directly without HTTP mocking. |
| **localStorage for state** | Matches starter spec; no new infra. Per-slide `status` field doubles as a state machine for the upcoming "Cook all" feature. |
| **No streaming yet** | Deferred. Would require server-side orchestration for diminishing returns at 5-15 slide decks. Listed in "What's next." |

---

## Repo structure

```
app/
  page.tsx                    ← single-page slide builder UI
  layout.tsx, globals.css
  api/
    generate/route.ts         ← thin adapter → lib/ai/generate-slide
    deck-from-brief/route.ts  ← thin adapter → lib/ai/generate-outline
    export/route.ts           ← PPTX assembly via pptxgenjs

lib/
  ai/
    client.ts                 ← shared GoogleGenAI client + model constants
    helpers.ts                ← stripFences, extractText, normalizeFormat, types
    generate-slide.ts         ← classifier + image/layout dispatch
    generate-outline.ts       ← deck-from-brief logic

tests/
  unit/                       ← pure functions (helpers, classifier prompt invariants)
  integration/                ← route handlers with @google/genai mocked

scripts/
  smoke-test.mjs              ← end-to-end against running dev server
```

---

## What I'd build next

Listed in priority order. Each one is achievable in a few hours; the structure is set up to support them without further refactoring.

1. **Cook all + tiered parallel generation.** Right now the user has to click "Cook" on each slide after `Deck-from-brief` produces an outline. Add a single button that fires all slides in parallel — layouts unthrottled (cheap, fast), image generation capped at 3 in-flight (rate limits). Show progress per slide via the existing `status` field.
2. **Presenter mode.** Full-screen, keyboard nav. Removes the export step for many use cases.
3. **Style lock / visual theme.** After the first image is generated, extract its color palette + composition style and inject into all subsequent image prompts. Fixes the "every slide looks like a different designer" problem.
4. **Variants per slide.** Instead of "Again" replacing the current image, show 3 variants side-by-side. Standard creative-tool pattern.
5. **Voice-to-deck.** Whisper API → outline → deck. The wow factor is high and the architecture supports it cleanly (just another input that produces a brief).

---

## Tech stack

| | |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| AI | Gemini 2.5 Flash-Lite (text), Gemini 3 Pro Image Preview (image) |
| Export | pptxgenjs |
| Testing | Vitest |
| State | React + localStorage (no Zustand, no DB) |
| Styling | Plain CSS in `globals.css` |

---

## Acknowledgments

The starter was provided by Valon. The original repo lives at the upstream of this fork. The brief was: take this rough seed and turn it into something stronger.
