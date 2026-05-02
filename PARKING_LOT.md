# Parking lot

Ideas that came up while building this take-home but didn't ship. Kept here so the README's "What's next" stays curated to the top three.

Format per item: **what / why now / size / sketch.** Sized in rough hour buckets (S = ~2h, M = ~half a day, L = a full day or more).

---

## Real streaming (server-pushed phase events)

**What:** Replace the client-side elapsed-time + calibrated-hint feedback (already shipped) with real server-side events so the UI can show classifier-finished, image-started, image-decoded as they happen.

**Why later:** Gemini's image API doesn't stream today. Would require either (a) emitting our own SSE events around each model call from the route handler — useful but only as fast as the slowest call — or (b) waiting for upstream streaming support. The shipped honest-elapsed-time UX captures most of the perceived-speed benefit; this is the next step when we want true progress signals.

**Size:** M for SSE wrapper, L if we want partial-image streaming (gated on Gemini API).

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
