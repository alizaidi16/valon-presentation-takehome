# Slides — a Valon take-home

> Type a brief. Get a deck. Pick the right format for every slide.

This is my submission for the Valon presentation take-home. The starter was an image-only slide builder; I rebuilt the generation pipeline to be **format-aware** and added a **deck-from-brief** flow. A reviewer reading this should expect the full vitest suite to pass and a working app in under a minute of setup.

> **Demo:** drop a GIF here at `docs/screenshots/deck-from-brief.gif` showing the full flow — type brief → outline appears → cook a few slides → mixed-format deck.

---

## What's new vs the starter

The original starter would generate one image per slide. That's the wrong format for ~40% of slides — agendas, feature grids, stat callouts, comparison tables. Image models can't render legible body text, so a "key metrics" slide came back as a Comic Sans hallucination. The work below addresses that root problem and builds on top of it.

- **AI-routed format selection** — every prompt is classified before generation. Image vs `title` / `bullets` / `grid` / `stats`. Layout slides skip the image model entirely (~10x cheaper, ~5x faster).
- **Deck-from-brief** — input a paragraph (audience, purpose, tone) and get a full outline back: deck title, named slides, refined prompts, pre-set formats, and speaker notes. Click to open the brief overlay from the sidebar.
- **Per-slide format override** — chip selector lets you force any format if you disagree with the classifier. The chips are bound per-slide, so different slides remember their own choice.
- **Cook all + tiered concurrency** — fires all idle slides in parallel. Layouts unthrottled; image generation capped at 3 in-flight to respect rate limits. Per-slide progress via the same `status` field; `Stop` aborts in-flight requests; `Retry failed` re-runs only the broken ones.
- **Presenter mode** — full-screen, keyboard navigation (← → space PgUp/PgDn Home/End Esc), speaker-notes drawer (toggle with `N`).
- **AI slide critique** — multimodal "Critique" button that sends image slides back to the model so it actually sees what it's grading. Returns structured feedback (overall verdict + 0-5 strengths + 0-5 issues with severity, area, and a concrete suggested fix), rendered in a slide-in side drawer.
- **Theme system + Style Lock** — presets **Default** (`default` id — Valon-aligned cream/gold look), **Monochrome**, and legacy **`pitch`** for older shared decks; optional per-deck **typography** (slide font stacks + scale) under Customize theme. **Lock style from this slide** extracts style DNA (palette + mood + image-prompt appendix) from a generated image and applies it deck-wide. One abstraction controls layout slide CSS, image-prompt appendix, and PPTX colors in lockstep — so the same deck stays visually coherent end-to-end.
- **Live generation feedback** — elapsed-time counter on every working slide, calibrated phase hints based on (kind, elapsed), shimmer animation across the canvas, accent-colored progress bar, and animated thumbnails. Honest about what's happening — no fake server events.
- **Classifier reasoning surfaced in the UI** — the floating chip on the canvas shows *why* the AI picked the format it did. No more silent failures.
- **Real PPTX export for layout slides** — proper text layout, not "image overlay with placeholder rectangle." Each layout type has its own pptxgenjs renderer; the active theme's colors flow through.
- **Share / export menu** — one toolbar control opens a short menu: **Download** (starts `.pptx` download) or **Share link** (copies a compressed `#share=` URL with deck structure, prompts, notes, formats, layout JSON, and the active theme). Image bytes are intentionally omitted (URLs would blow past limits); open the link and **Cook** to regenerate pixels.
- **Undo / redo** — global **⌘Z** / **⌘⇧Z** (Ctrl on Windows/Linux) for structural deck changes, plus matching **←** / **→** controls in the toolbar; text fields keep the browser’s native undo.
- **Drag-to-reorder slides** — sidebar thumbnails use **@dnd-kit** sortable reorder; order persists with the rest of the deck.
- **3 looks** — for image-format slides, runs three parallel image generations with variation hints, then A/B/C thumbnails under the canvas to pick a winner (thumbnails collapse to a single canonical `imageData`).
- **Voice brief (dictation)** — Web Speech API toggle in the deck-from-brief overlay (Chrome / Edge / Safari; feature-hidden where unsupported). Streams interim text into the brief textarea.
- **Vitest suite** — unit + integration tests (including share-hash round-trip where `CompressionStream` exists), smoke script for end-to-end against a live dev server. No API key required for the offline tests.

---

## Run it

```bash
cp .env.example .env.local                    # add GOOGLE_API_KEY
npm install
npm run dev                                   # opens on :3000 if free; otherwise Next picks the next port (see terminal)
```

Optional env vars:
- `GOOGLE_TEXT_MODEL` — defaults to `gemini-2.5-flash-lite` (purpose-built for classification at scale)
- `GOOGLE_IMAGE_MODEL` — defaults to `gemini-3-pro-image-preview`

## Test it

```bash
npm test                  # unit + integration tests, no API key needed
npm run test:smoke        # end-to-end against the dev server URL (defaults to http://localhost:3000)
npm run typecheck         # strict TS, zero errors
```

The smoke script gracefully skips live AI tests when `GOOGLE_API_KEY` isn't set, so it doubles as a CI-friendly check that the routes are wired correctly.

---

## Architecture

Four **AI** flows (classify / generate / critique / extract style) mapped to four `POST` routes under `app/api/`; all logic lives in `lib/ai/`. **`POST /api/export`** builds PPTX client-side on the server via pptxgenjs (not a Gemini call). Routes are thin HTTP adapters.

```
                    ┌─────────────────────────────────────────┐
                    │  Browser — app/page.tsx                 │
                    │  React state + localStorage             │
                    │  Active Theme drives image prompts +    │
                    │  layout slide CSS + PPTX colors         │
                    └────────────┬────────────────────────────┘
                                 │
   ┌─────────────────┬───────────┴──────────┬─────────────────────┐
   ▼                 ▼                      ▼                     ▼
POST /api/      POST /api/           POST /api/             POST /api/
generate        deck-from-brief      critique               extract-style
{prompt,        {brief,              {prompt, kind,         {imageData}
 format,        slideCount?}          imageData|layout}
 styleAppendix}
   │                 │                      │                     │
   ▼                 ▼                      ▼                     ▼
generate-slide   generate-outline      critique              extract-style
.ts              .ts                   .ts                   .ts
   │                 │                      │                     │
   ├ classifier      → outline (Flash-Lite) ├ image: send         ├ VLM call
   │  (Flash-Lite)     → { deckTitle,       │  rendered PNG       │  with image
   │                     slides[] with      │  as inlineData      │  + structured
   ├ image path:        suggestedFormat,    │                     │  output prompt
   │  image model       notes }             ├ layout: send        │
   │  (Gemini 3 Pro                         │  JSON content       ▼
   │  Image Preview)                        │              { palette: { paper,
   │  + styleAppendix                       ▼                       ink, accent },
   │                                Critique:                  mood,
   └ layout path:                  { overall, summary,         imagePromptAppendix }
      content via                     strengths[],                  │
      Flash-Lite                      issues[{                      ▼
                                        severity, area,       buildLockedTheme()
                                        message,              → Theme used as
                                        suggestion }] }         deck-wide style
```

**Why classify first?** Image models cannot render legible body text. Any slide where the user expects to *read* lists, stats, or paragraphs must be a layout. Title layout is text-on-paper only — if the brief asks for a **hero image, cover shot, or photographic opener** (even alongside a headline), the router must pick the **image** path. Rules and examples live in `lib/ai/generate-slide.ts → buildClassificationPrompt`. Layout trigger keywords (`agenda`, `metrics`, `list`, `roadmap`, `comparison`) apply when they describe the core slide payload, not incidental phrasing next to a dominant visual ask.

**Why Gemini Flash-Lite?** Google specifically pitches it for *"high throughput tasks like classification or summarization at scale"* — exactly our workload. ~10x cheaper than Anthropic Haiku and noticeably faster. We don't need reasoning quality here; the classifier output is constrained JSON. Critique and style extraction reuse the same model — Flash-Lite handles multimodal input fine for these structured tasks.

**Why themes as one abstraction?** A theme bundles `cssVars` (layout slide rendering), `pptx` (export colors), `imagePromptAppendix` (image generation guidance), and optional `typography`. When you switch theme, those layers flip in lockstep — so visuals, export, and prompts stay aligned. The **locked** theme is constructed at runtime from a style DNA extracted via the VLM, but follows the same `Theme` shape, so the rest of the system never knows the difference. Persisted decks may still carry the legacy preset id **`editorial`**; hydration maps it to **`default`**.

---

## Design decisions (and the alternatives I considered)

| Decision | Why |
|---|---|
| **Two-step pipeline (classify → dispatch)** | Lets us route layout slides away from the image model entirely. Tradeoff: one extra model call on the image path. Worth it because the saved layout calls dominate. |
| **Layout content lives in app state, not as image data** | Renders in real DOM (selectable, accessible, infinitely sharp). PPTX export builds real text frames, not screenshots. |
| **Per-slide `suggestedFormat` field** | Lets deck-from-brief pre-set each slide's format. The chips bind to whatever slide is selected. Cleaner than a global override. |
| **Fail loud on classifier errors** | Original code silently fell back to image, which produced the Comic Sans hallucination. Now: 502 with the raw model output in the error message — debuggable. |
| **`lib/ai/` separation** | Routes became 25 lines each. Lib functions are pure (input → output, no `Request`/`Response`). Tests can hit them directly without HTTP mocking. |
| **localStorage for state** | Matches starter spec; no new infra. Base64 slides can exceed the browser ~5 MB/origin quota — the app proactively drops image bytes when the snapshot is oversized or `QuotaExceededError` fires (prompts/layouts still persist; heroes survive until reload in the current tab). |
| **No streaming yet** | Deferred. Would require server-side orchestration for diminishing returns at 5-15 slide decks. Listed in "What's next." |
| **Stripped the starter's joke "cheesy" aesthetic** | The original `HOUSE_STYLE_APPENDIX` told the image model to render in Comic Sans with clashing colors, and `globals.css` matched. Funny once; gets in the way of evaluating real output. Replaced with a restrained editorial palette (cream paper, accent, Inter + Fraunces). PPTX export matches the active theme. Style Lock (extract DNA from one slide image) ships for cross-slide coherence. |

---

## Repo structure

```
app/
  page.tsx                    ← single-page slide builder UI
  layout.tsx, globals.css     ← Inter + Fraunces via next/font; theme CSS vars
  api/
    generate/route.ts         ← thin adapter → lib/ai/generate-slide
    deck-from-brief/route.ts  ← thin adapter → lib/ai/generate-outline
    critique/route.ts         ← thin adapter → lib/ai/critique
    extract-style/route.ts    ← thin adapter → lib/ai/extract-style
    export/route.ts           ← PPTX assembly via pptxgenjs (theme-aware)

lib/
  ai/
    client.ts                 ← shared GoogleGenAI client + model constants
    helpers.ts                ← stripFences, extractText, normalizeFormat, types
    generate-slide.ts         ← classifier + image/layout dispatch
    generate-outline.ts       ← deck-from-brief logic
    critique.ts               ← multimodal slide critique
    extract-style.ts          ← VLM style DNA extraction from an image
    themes.ts                 ← Theme type, presets, buildLockedTheme
  ui/
    working-feedback.ts       ← elapsed-time + workingHint helpers (pure)
    slide-thumbnail-heading.ts ← sidebar thumb labels (layout / prompt / first-slide name)
  async/
    pool.ts                   ← bounded-concurrency pool with abort support

tests/
  unit/                       ← pure functions (helpers, classifier invariants,
                                themes, working-feedback, pool)
  integration/                ← route handlers with @google/genai mocked

scripts/
  smoke-test.mjs              ← end-to-end against running dev server

CLAUDE.md                     ← concise notes for coding agents (this dir)
```

---

## What I'd build next

Top three only. Everything else is in [`PARKING_LOT.md`](PARKING_LOT.md).

1. **Real streaming (SSE).** Server-pushed phase events around classifier / layout / image completion so the UI moves past honest elapsed-time hints when the platform allows it.
2. **Cost estimator.** Pre-flight “~\$X to Cook this deck” from static model pricing × slide mix (classifier + layouts + images).
3. **Backed share URLs.** Today share is a long `#share=` hash in the URL; a tiny backend (KV or Supabase) could host `slides.example/d/<id>` read-only views without blowing browser URL limits.

Already shipped: AI-routed format selection, deck-from-brief, per-slide format chips, Cook all (tiered concurrency), **3 looks** (A/B/C image picks), Presenter mode (keyboard nav + speaker notes), AI slide critique (multimodal), theme system + typography + Style Lock, Share / export menu, undo/redo + drag-to-reorder thumbnails, voice brief (dictation), live generation feedback, and the visual reset.

For a shorter, tool-oriented recap (commands, theme ids, routes), see **`CLAUDE.md`**.

---

## Tech stack

| | |
|---|---|
| Framework | Next.js **16.2** (App Router), React **19.2**, TypeScript **6** |
| AI | Gemini 2.5 Flash-Lite (text), Gemini 3 Pro Image Preview (image) — defaults configurable via env |
| Export | pptxgenjs |
| DnD | @dnd-kit/core + sortable (slide reorder) |
| Testing | Vitest **4** |
| State | React + localStorage (no Zustand, no DB) |
| Styling | Plain CSS in `globals.css` |

---

## Acknowledgments

The starter was provided by Valon. The original repo lives at the upstream of this fork. The brief was: take this rough seed and turn it into something stronger.
