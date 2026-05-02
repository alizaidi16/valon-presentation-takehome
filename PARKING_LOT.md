# Parking lot

Ideas that came up while building this take-home but didn't ship. Kept here so the README's "What's next" stays curated to the top three.

Format per item: **what / why now / size / sketch.** Sized in rough hour buckets (S = ~2h, M = ~half a day, L = a full day or more).

---

## Option C — Style themes (visual DNA system)

> The deferred half of "fix the cheesy aesthetic." We did Option A (rip out Comic Sans + clashing colors, replace with one tasteful default). Option C is the bigger move: make the look *swappable*.

**Why it matters.** The starter shipped with one hard-coded look. Even after the cleanup, the user still gets exactly one look. A real product needs at least: the in-house default, a "client wants something dark," and "match my brand." Plus, by far the biggest aesthetic problem with image-generated decks is *intra-deck inconsistency* — every slide looks like a different designer. A theme system that controls both layout slides AND image prompts in lockstep solves both problems with one abstraction.

**Size:** L (full day to ship 2-3 themes plus the picker; image-DNA extraction is another half-day).

**Sketch:**

```ts
// lib/ai/themes.ts
export type Theme = {
  id: string;
  name: string;
  // CSS custom properties applied to <html>
  cssVars: Record<string, string>;
  // PPTX export colors (hex without #)
  pptx: { ink: string; inkSoft: string; accent: string; paper: string; rule: string };
  // Image prompt appendix
  imagePromptAppendix: string;
  // Font pairing
  fonts: { sans: string; display: string };
};

export const THEMES: Record<string, Theme> = {
  editorial: { /* current default — cream + terracotta + Inter/Fraunces */ },
  monochrome: { /* deep ink on warm white, no accent, big serif */ },
  pitch: { /* dark navy bg, white ink, electric blue accent, sans-only */ },
  brand: { /* user-supplied — picker */ }
};
```

Layered on top, an "extract from image" mode:

1. User generates the first image slide.
2. We send that image back to a VLM with a structured-output prompt: `{ palette: [hex, hex, hex], style: string, mood: string }`.
3. We construct a *derived theme* from that response and stick it in `THEMES.fromSlide1` for the rest of the deck.
4. All subsequent image prompts get the derived `imagePromptAppendix`; layout slides re-render with the derived `cssVars`.

**Open questions to answer before building:**
- Theme JSON in code vs DB? (Code for v1; DB once we add user accounts.)
- Should the picker live in the sidebar permanently or in a settings drawer? (Settings drawer — sidebar is already busy.)
- How do we handle a user changing themes mid-deck? Re-cook all the image slides? (Yes, with a confirmation modal — "this will regenerate N image slides.")

**Why we didn't do it now:** scope. Option A delivers 80% of the perceived improvement in 30 minutes. Option C is a real feature with its own design surface, picker UI, and PPTX rendering matrix. Worth its own PR.

---

## Streaming generation (per-slide progress within one slide)

**What:** Stream the image model's output so the user sees the image fade in as it's generated, instead of a 8-15s spinner.

**Why later:** Gemini's image API doesn't support streaming today. Would have to fake it (poll `generateContent` with a smaller `imageSize`, then progressively upscale). The juice/squeeze ratio is bad while the underlying API isn't there.

**Size:** M, gated on Gemini API support.

---

## Cost estimator UI

**What:** Show the user "this deck will cost ~$0.42 to generate" before they hit Cook all. Include token counts for the classifier and per-image pricing.

**Why later:** Useful only once Conserge-style usage limits or per-customer billing exist. For a take-home, it adds noise.

**Size:** S. Just a static lookup table of model prices × an estimator that walks the slide list.

---

## Drag-to-reorder slides

**What:** Drag a thumbnail in the sidebar to reorder slides.

**Why later:** Add slide / delete slide are the high-frequency operations; reorder is rare in a 5-15 slide deck. Worth it once decks get bigger.

**Size:** S. Reach for `@dnd-kit/sortable`, swap the `slides` array on drop, persist via the existing localStorage hook.

---

## Undo / redo

**What:** Cmd+Z reverts the last slide change (cook, edit, delete, reorder).

**Why later:** With localStorage persistence and a 5-15 slide ceiling, the cost of a mistake is low. Becomes important once we have collaborative editing or paid tiers where a wasted image costs real money.

**Size:** M. Needs a small command-pattern abstraction over the slide store; currently slides are mutated in-place via `setSlides`.

---

## URL-based collab / share

**What:** Sharable read-only deck URL. Click "Share" → get `slides.app/d/<id>` that loads the same deck in someone else's browser.

**Why later:** Needs a backing store (Supabase or KV). Out of scope for a single-day take-home.

**Size:** L. New service layer, auth-ish (anonymous share tokens), DB schema for decks/slides.

---

## Per-image style preview before commit

**What:** Show 4 thumbnail variants instead of one full-size image. User picks one, that becomes the slide.

**Why later:** Quadruples per-slide cost and latency without proven user demand. The "Again" button is a poor man's version of this and works fine for now.

**Size:** M. Mostly a UI change; backend already supports `variation: true`.

---

## Smarter classifier with few-shot examples from user history

**What:** Track which formats the user most often picks for which kinds of prompts. Bias the classifier with their last 10 overrides.

**Why later:** Needs a backing store for user history. Useful only at higher session counts than a take-home reviewer will hit.

**Size:** M.

---

## "Speaker notes" generated from layout content

**What:** When a layout slide is generated, also generate the speaker notes the presenter would say out loud about it. Today the user has to write notes by hand.

**Why later:** The deck-from-brief flow already produces `notes` per slide. Adding it to the single-slide cook flow is a one-prompt extension — easy follow-up if the deck-from-brief notes prove useful in practice.

**Size:** S. One extra field in the layout response schema.

---

## Inbound brief over email

**What:** Reviewer emails `decks@…` with a brief in the body. Reply comes back with a Loom-style preview link to the generated deck.

**Why later:** Cute distribution, but it's marketing surface, not core product. Conserge has the inbound-email infra (Postmark webhook); this app doesn't yet.

**Size:** L. New surface area entirely.
