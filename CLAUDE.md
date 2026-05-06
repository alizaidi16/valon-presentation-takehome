# CLAUDE.md — Deck studio (Valon take-home)

Condensed context for AI-assisted work in this repo. The full narrative lives in `README.md`.

## What this is

Next.js **single-page** slide builder: AI classifies each slide as **image** vs **layout** (`title` / `bullets` / `grid` / `stats`), generates content, exports real **PPTX**, and supports **share-by-URL** (`#share=`) without hosting image bytes.

## Commands

```bash
cp .env.example .env.local   # set GOOGLE_API_KEY for live AI
npm install
npm run dev                  # Next prints the port (3000 if free)
npm test
npm run typecheck
npm run build
npm run test:smoke           # needs a running dev server
```

## Environment

- **`GOOGLE_API_KEY`** — required for classifier, images, brief, critique, style lock.
- **`GOOGLE_TEXT_MODEL`** / **`GOOGLE_IMAGE_MODEL`** — optional; defaults in `.env.example`.

## Layout of the code

| Area | Role |
|------|------|
| `app/page.tsx` | All UI: deck, sidebar thumbnails (**@dnd-kit** reorder), presenter, brief wizard, theme, export/share menu |
| `app/api/generate` | Slide generation → `lib/ai/generate-slide` |
| `app/api/deck-from-brief` | Outline → `lib/ai/generate-outline` |
| `app/api/critique` | Slide critique |
| `app/api/extract-style` | Style lock (VLM DNA) |
| `app/api/export` | PPTX (**not** a generative route) |
| `lib/ai/themes.ts` | `Theme` type, presets, `buildLockedTheme`, `coercePersistedTheme` (migrates legacy `editorial` → `default`, `source: website` → `default`) |
| `lib/ui/editable-layout-slide.tsx` | In-canvas editors for layout JSON (`title` / `bullets` / `grid` / `stats`); commits on blur; **stats** optional headline matches read-only (hidden when empty, **+ Section headline** to add) |
| `lib/ui/slide-thumbnail-heading.ts` | Thumbnail labels; pass `{ listIndex }` so the **first** thumb uses `slide.name` when set |

There is **no** server route to import a palette from an external website (that flow was removed).

## Slide surface: edit vs present

- **Layout slides:** `EditableLayoutSlide` in the main canvas; Present / thumbnails use read-only `LayoutSlide` (`app/page.tsx`).
- **Sizing:** `.canvas-card` and `.presenter-stage` use **`container-type: size`** so `clamp(..., …cqw, …)` layout typography scales with the **slide**, not `vw`. Generic `.layout-slide-editable input.ls-editable-field` used to set `font-size: inherit` — **stat value/label inputs** override with the same **clamp** sizes as `.ls-stat-value` / `.ls-stat-label` so big numbers / small labels match Present.
- **Images:** Editor stack uses **`object-fit: contain`** + black ground under the image (aligned with Present). Editable **slide title** = `slide.name`.

## Themes (important)

- **`ThemeId`**: `default` \| `monochrome` \| `pitch` \| `custom` \| `locked`.
- **UI presets**: **Default** + **Monochrome**; **`pitch`** remains for legacy/shared payloads.
- Use **`default`**, not **`editorial`** (old id is coerced on load).
- A theme drives **`cssVars`**, **`pptx`** hexes, **`imagePromptAppendix`**, and optional **`typography`** (slide fonts + scale).

## UX details worth not breaking

- Toolbar **Share / export**: one control; menu items **Download** (.pptx) and **Share link** (clipboard).
- **Undo / redo**: toolbar ← / → and global **⌘Z** / **⌘⇧Z** (skipped when focus is in text fields).
- **First thumbnail** heading: `slideThumbnailHeading(slide, { listIndex: index })`.
- Rich **inline formatting** and **manual shapes/text boxes** are not implemented — see [`PARKING_LOT.md`](PARKING_LOT.md).

## Tests

- **Vitest** under `tests/unit` and `tests/integration`; no API key for offline tests.
- Smoke script hits a live server; skips heavy AI checks without a key.

## Dependency snapshot (see `package.json` for truth)

Next.js **16**, React **19**, TypeScript **6**, `@google/genai`, `pptxgenjs`, `@dnd-kit/*`, Vitest **4**.
