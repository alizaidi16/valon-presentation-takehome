"use client";

import { useEffect, useRef, useState } from "react";
import { pool } from "@/lib/async/pool";
import type { Critique } from "@/lib/ai/critique";
import type { StyleDNA } from "@/lib/ai/extract-style";
import {
  buildLockedTheme,
  DEFAULT_THEME,
  PRESET_THEME_LIST,
  getPresetTheme,
  type Theme,
  type ThemeId
} from "@/lib/ai/themes";

type SlideStatus = "idle" | "working" | "done" | "error";
type FormatOverride = "auto" | "image" | "title" | "bullets" | "grid" | "stats";

const FORMAT_OPTIONS: Array<{ value: FormatOverride; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "image", label: "image" },
  { value: "title", label: "title" },
  { value: "bullets", label: "bullets" },
  { value: "grid", label: "grid" },
  { value: "stats", label: "stats" }
];

type TitleLayout = { kind: "title"; headline: string; subtitle?: string };
type BulletsLayout = { kind: "bullets"; headline: string; bullets: string[] };
type GridLayout = {
  kind: "grid";
  headline: string;
  items: Array<{ title: string; body: string }>;
};
type StatsLayout = {
  kind: "stats";
  headline?: string;
  stats: Array<{ value: string; label: string }>;
};
type SlideLayout = TitleLayout | BulletsLayout | GridLayout | StatsLayout;

type Slide = {
  id: string;
  name: string;
  prompt: string;
  kind?: "image" | "layout";
  imageData?: string;
  layout?: SlideLayout;
  status: SlideStatus;
  note: string;
  feedback?: string;
  /** Pre-set by deck-from-brief generator; user can still change it via the chips. */
  suggestedFormat?: FormatOverride;
  /** AI critique result. Persists across slide-switches so the drawer stays useful. */
  critique?: Critique;
  /** Loading flag for the critique call. Independent of `status` so a user can
   * critique a done slide without disabling the cook controls. */
  critiquing?: boolean;
};

type OutlineSlide = {
  name: string;
  prompt: string;
  suggestedFormat: FormatOverride;
  notes: string;
};

type DeckOutline = {
  deckTitle: string;
  slides: OutlineSlide[];
};

const STORAGE_KEY = "valon-presentation-takehome-v5";

function makeSlide(index: number): Slide {
  return {
    id: crypto.randomUUID(),
    name: `Slide ${index + 1}`,
    prompt:
      index === 0
        ? "An editorial title slide for a mortgage startup, with a single hero image and a confident headline"
        : "",
    status: "idle",
    note: ""
  };
}

function starterSlides(): Slide[] {
  return [makeSlide(0), makeSlide(1)];
}

function getLayoutHeadline(layout: SlideLayout): string {
  if (layout.kind === "stats") return layout.headline ?? `${layout.stats.length} stats`;
  return layout.headline;
}

function LayoutSlide({ layout }: { layout: SlideLayout }) {
  if (layout.kind === "title") {
    return (
      <div className="layout-slide layout-title">
        <p className="ls-headline">{layout.headline}</p>
        {layout.subtitle && <p className="ls-subtitle">{layout.subtitle}</p>}
      </div>
    );
  }

  if (layout.kind === "bullets") {
    return (
      <div className="layout-slide layout-bullets">
        <p className="ls-section-headline">{layout.headline}</p>
        <ul className="ls-bullet-list">
          {layout.bullets.map((bullet, i) => (
            <li key={i} className="ls-bullet-item">
              {bullet}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (layout.kind === "grid") {
    return (
      <div className="layout-slide layout-grid">
        <p className="ls-section-headline">{layout.headline}</p>
        <div className="ls-grid-items">
          {layout.items.map((item, i) => (
            <div key={i} className="ls-grid-item">
              <p className="ls-grid-title">{item.title}</p>
              <p className="ls-grid-body">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (layout.kind === "stats") {
    return (
      <div className="layout-slide layout-stats">
        {layout.headline && <p className="ls-section-headline">{layout.headline}</p>}
        <div className="ls-stats-row">
          {layout.stats.map((stat, i) => (
            <div key={i} className="ls-stat-item">
              <p className="ls-stat-value">{stat.value}</p>
              <p className="ls-stat-label">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export default function Home() {
  const [slides, setSlides] = useState<Slide[]>(starterSlides);
  const [selectedId, setSelectedId] = useState<string>("");
  const [message, setMessage] = useState("Local only. This does not sync anywhere.");
  const [exporting, setExporting] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefText, setBriefText] = useState("");
  const [briefSlideCount, setBriefSlideCount] = useState<number | "">(7);
  const [briefRunning, setBriefRunning] = useState(false);
  const [cookingAll, setCookingAll] = useState(false);
  const cookAbortRef = useRef<AbortController | null>(null);
  const [presenterOpen, setPresenterOpen] = useState(false);
  const [presenterIndex, setPresenterIndex] = useState(0);
  const [presenterShowNotes, setPresenterShowNotes] = useState(false);
  const [critiquePanelOpen, setCritiquePanelOpen] = useState(false);
  /** Active deck theme. Either a preset (selected via the theme picker) or
   * a "locked" theme extracted from a generated image slide. Persisted to
   * localStorage so reloads preserve the look. */
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [lockingStyle, setLockingStyle] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);

    if (!saved) {
      const fresh = starterSlides();
      setSlides(fresh);
      setSelectedId(fresh[0]?.id ?? "");
      return;
    }

    try {
      const parsed = JSON.parse(saved) as {
        slides: Slide[];
        selectedId: string;
        theme?: Theme;
      };

      if (parsed.slides?.length) {
        setSlides(parsed.slides);
        setSelectedId(parsed.selectedId || parsed.slides[0].id);
      }
      if (parsed.theme && parsed.theme.cssVars && parsed.theme.pptx) {
        setTheme(parsed.theme);
      }
    } catch {
      const fresh = starterSlides();
      setSlides(fresh);
      setSelectedId(fresh[0]?.id ?? "");
    }
  }, []);

  useEffect(() => {
    if (!slides.length) {
      return;
    }

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ slides, selectedId: selectedId || slides[0].id, theme })
    );
  }, [slides, selectedId, theme]);

  /**
   * Apply the active theme by writing its CSS custom properties onto
   * <html>. Layout slides + UI surfaces read these vars from globals.css,
   * so a single theme change re-skins everything visible.
   */
  useEffect(() => {
    const root = document.documentElement;
    const v = theme.cssVars;
    root.style.setProperty("--bg", v.bg);
    root.style.setProperty("--paper", v.paper);
    root.style.setProperty("--ink", v.ink);
    root.style.setProperty("--ink-soft", v.inkSoft);
    root.style.setProperty("--ink-muted", v.inkMuted);
    root.style.setProperty("--rule", v.rule);
    root.style.setProperty("--rule-strong", v.ruleStrong);
    root.style.setProperty("--accent", v.accent);
    root.style.setProperty("--accent-soft", v.accentSoft);
    root.dataset.theme = theme.id;
  }, [theme]);

  const selectedSlide = slides.find((slide) => slide.id === selectedId) ?? slides[0];

  useEffect(() => {
    if (!selectedSlide && slides[0]) {
      setSelectedId(slides[0].id);
    }
  }, [selectedSlide, slides]);

  function patchSlide(id: string, patch: Partial<Slide>) {
    setSlides((current) =>
      current.map((slide) => (slide.id === id ? { ...slide, ...patch } : slide))
    );
  }

  function addSlide() {
    const next = makeSlide(slides.length);
    setSlides((current) => [...current, next]);
    setSelectedId(next.id);
    setMessage("Added another page.");
  }

  function killSlide(id: string) {
    if (slides.length === 1) {
      setMessage("One page is the floor.");
      return;
    }

    const nextSlides = slides.filter((slide) => slide.id !== id);
    setSlides(nextSlides);

    if (selectedId === id) {
      setSelectedId(nextSlides[0]?.id ?? "");
    }

    setMessage("A page vanished.");
  }

  /**
   * Cook one slide. Patches the slide's status as it progresses. Used by both
   * the single-slide "Cook" button and the batch "Cook all" flow.
   */
  async function cookOneSlide(
    slide: Slide,
    options: { variation?: boolean; signal?: AbortSignal } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    const { variation = false, signal } = options;

    if (!slide.prompt.trim()) {
      patchSlide(slide.id, { status: "error", feedback: "No prompt." });
      return { ok: false, reason: "No prompt." };
    }

    const slideFormat: FormatOverride = slide.suggestedFormat ?? "auto";
    const formatLabel =
      slideFormat === "auto" ? "best format" : `${slideFormat} layout`;
    patchSlide(slide.id, {
      status: "working",
      feedback: variation ? "Trying a different take..." : `Figuring out the ${formatLabel}...`
    });

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          prompt: slide.prompt,
          variation,
          formatOverride: slideFormat,
          // Image generations get the active theme's appendix so the deck
          // stays visually coherent. Layout slides ignore this server-side.
          styleAppendix: theme.imagePromptAppendix
        })
      });

      const payload = (await response.json()) as {
        error?: string;
        kind?: "image" | "layout";
        imageData?: string;
        layout?: SlideLayout;
        text?: string;
        reasoning?: string;
      };

      if (!response.ok || payload.error) {
        patchSlide(slide.id, {
          status: "error",
          feedback: payload.error ?? "Generation failed."
        });
        return { ok: false, reason: payload.error ?? "Generation failed." };
      }

      if (payload.kind === "layout" && payload.layout) {
        patchSlide(slide.id, {
          kind: "layout",
          layout: payload.layout,
          imageData: undefined,
          status: "done",
          feedback: payload.reasoning ?? `Layout: ${payload.layout.kind}`
        });
        return { ok: true };
      }

      if (payload.kind === "image" && payload.imageData) {
        patchSlide(slide.id, {
          kind: "image",
          imageData: payload.imageData,
          layout: undefined,
          status: "done",
          feedback: payload.reasoning ?? payload.text ?? "Done."
        });
        return { ok: true };
      }

      patchSlide(slide.id, { status: "error", feedback: "Unexpected response from generator." });
      return { ok: false, reason: "Unexpected response from generator." };
    } catch (err) {
      // AbortError: revert to idle so the user can retry; otherwise mark error
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      patchSlide(slide.id, {
        status: isAbort ? "idle" : "error",
        feedback: isAbort ? "Cancelled." : err instanceof Error ? err.message : "Network error."
      });
      return { ok: false, reason: isAbort ? "cancelled" : "network error" };
    }
  }

  async function generateSlide(variation: boolean) {
    if (!selectedSlide) return;
    if (!selectedSlide.prompt.trim()) {
      setMessage("Needs a prompt first.");
    }
    setMessage(variation ? "Trying a variation." : "Cooking...");
    const { ok, reason } = await cookOneSlide(selectedSlide, { variation });
    setMessage(ok ? "Slide ready." : reason ?? "Generation failed.");
  }

  /**
   * Tiered batch: layout slides go in parallel (cheap, fast), image/auto slides
   * are throttled to 3 concurrent (rate-limit friendly). Layout slides typically
   * resolve within seconds, giving the user fast visible progress.
   */
  async function cookAllSlides(opts: { onlyFailed?: boolean } = {}) {
    const targets = slides.filter((s) => {
      if (opts.onlyFailed) return s.status === "error";
      return s.status !== "done" && s.status !== "working";
    });

    if (!targets.length) {
      setMessage(opts.onlyFailed ? "Nothing to retry." : "All slides are already done.");
      return;
    }

    const controller = new AbortController();
    cookAbortRef.current = controller;
    setCookingAll(true);

    const layoutSlides = targets.filter(
      (s) => s.suggestedFormat && s.suggestedFormat !== "auto" && s.suggestedFormat !== "image"
    );
    const imageOrAutoSlides = targets.filter(
      (s) => !s.suggestedFormat || s.suggestedFormat === "auto" || s.suggestedFormat === "image"
    );

    setMessage(
      `Cooking ${targets.length} slides (${layoutSlides.length} layout, ${imageOrAutoSlides.length} image/auto)...`
    );

    let done = 0;
    let failed = 0;
    const onSettled = (_i: number, settled: { status: "fulfilled" | "rejected" }) => {
      if (settled.status === "fulfilled") done++;
      else failed++;
      const total = targets.length;
      setMessage(`Cooked ${done + failed} of ${total}${failed ? ` (${failed} failed)` : ""}...`);
    };

    try {
      // Run both pools in parallel — layouts unthrottled, images capped at 3
      await Promise.all([
        pool(
          layoutSlides.map((slide) => async (signal: AbortSignal) => {
            const result = await cookOneSlide(slide, { signal });
            if (!result.ok) throw new Error(result.reason ?? "failed");
            return result;
          }),
          { limit: Math.max(layoutSlides.length, 1), signal: controller.signal, onSettled }
        ),
        pool(
          imageOrAutoSlides.map((slide) => async (signal: AbortSignal) => {
            const result = await cookOneSlide(slide, { signal });
            if (!result.ok) throw new Error(result.reason ?? "failed");
            return result;
          }),
          { limit: 3, signal: controller.signal, onSettled }
        )
      ]);

      const finalDone = done;
      const finalFailed = failed;
      if (finalFailed === 0) {
        setMessage(`Done. Cooked ${finalDone} of ${targets.length}.`);
      } else {
        setMessage(
          `Cooked ${finalDone} of ${targets.length}. ${finalFailed} failed — try "Retry failed".`
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Batch failed.");
    } finally {
      cookAbortRef.current = null;
      setCookingAll(false);
    }
  }

  function cancelCookAll() {
    cookAbortRef.current?.abort();
    cookAbortRef.current = null;
    setMessage("Stopping...");
  }

  /**
   * Run AI critique on a slide. Sends the rendered content (image bytes for
   * image slides, structured layout for layout slides) to the model and
   * stores the result on `slide.critique`. Auto-opens the drawer on success.
   */
  async function critiqueSelectedSlide() {
    if (!selectedSlide) return;
    if (selectedSlide.status !== "done" || (!selectedSlide.imageData && !selectedSlide.layout)) {
      setMessage("Cook the slide first, then critique.");
      return;
    }

    patchSlide(selectedSlide.id, { critiquing: true });
    setMessage("Asking for honest feedback...");

    try {
      const response = await fetch("/api/critique", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: selectedSlide.prompt,
          name: selectedSlide.name,
          notes: selectedSlide.note,
          kind: selectedSlide.kind,
          imageData: selectedSlide.imageData,
          layout: selectedSlide.layout
        })
      });

      const payload = (await response.json()) as Critique & { error?: string };

      if (!response.ok || payload.error) {
        patchSlide(selectedSlide.id, { critiquing: false });
        setMessage(payload.error ?? "Critique failed.");
        return;
      }

      patchSlide(selectedSlide.id, { critiquing: false, critique: payload });
      setCritiquePanelOpen(true);
      const issueCount = payload.issues.length;
      setMessage(
        `Critique ready: ${payload.overall}. ${issueCount} issue${issueCount === 1 ? "" : "s"} flagged.`
      );
    } catch (err) {
      patchSlide(selectedSlide.id, { critiquing: false });
      setMessage(err instanceof Error ? err.message : "Critique failed.");
    }
  }

  /**
   * Extract a style DNA from the selected slide's image and use it as the
   * deck-wide theme. All future image generations will use the extracted
   * imagePromptAppendix and the layout slides re-skin to the extracted
   * palette via the theme effect above.
   */
  async function lockStyleFromSelectedSlide() {
    if (!selectedSlide?.imageData) {
      setMessage("Lock style only works on a generated image slide.");
      return;
    }

    setLockingStyle(true);
    setMessage("Reading the slide's visual DNA...");

    try {
      const response = await fetch("/api/extract-style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: selectedSlide.imageData })
      });

      const payload = (await response.json()) as Partial<StyleDNA> & { error?: string };

      if (
        !response.ok ||
        payload.error ||
        !payload.palette ||
        !payload.imagePromptAppendix
      ) {
        setMessage(payload.error ?? "Style extraction failed.");
        return;
      }

      const lockedTheme = buildLockedTheme({
        palette: payload.palette,
        mood: payload.mood,
        imagePromptAppendix: payload.imagePromptAppendix
      });
      setTheme(lockedTheme);
      setMessage(
        `Locked style: ${lockedTheme.name}. New image slides will match this look.`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Style extraction failed.");
    } finally {
      setLockingStyle(false);
    }
  }

  function openPresenter() {
    if (!slides.length) return;
    const startIndex = Math.max(
      0,
      slides.findIndex((s) => s.id === selectedId)
    );
    setPresenterIndex(startIndex);
    setPresenterOpen(true);
  }

  // Keyboard navigation while presenting
  useEffect(() => {
    if (!presenterOpen) return;

    function onKey(event: KeyboardEvent) {
      switch (event.key) {
        case "Escape":
          setPresenterOpen(false);
          break;
        case "ArrowRight":
        case " ":
        case "PageDown":
          event.preventDefault();
          setPresenterIndex((i) => Math.min(slides.length - 1, i + 1));
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          setPresenterIndex((i) => Math.max(0, i - 1));
          break;
        case "Home":
          event.preventDefault();
          setPresenterIndex(0);
          break;
        case "End":
          event.preventDefault();
          setPresenterIndex(slides.length - 1);
          break;
        case "n":
        case "N":
          setPresenterShowNotes((v) => !v);
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenterOpen, slides.length]);

  async function exportDeck() {
    if (!slides.length) {
      return;
    }

    setExporting(true);
    setMessage("Packing a .pptx.");

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Valon Presentation Takehome Export",
          slides,
          theme
        })
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Export failed.");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "valon-presentation-takehome-export.pptx";
      anchor.click();
      window.URL.revokeObjectURL(url);
      setMessage("Download started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function generateFromBrief() {
    if (!briefText.trim()) {
      setMessage("Need a brief to work from.");
      return;
    }

    setBriefRunning(true);
    setMessage("Drafting a deck outline...");

    try {
      const response = await fetch("/api/deck-from-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: briefText.trim(),
          slideCount: typeof briefSlideCount === "number" ? briefSlideCount : undefined
        })
      });

      const payload = (await response.json()) as Partial<DeckOutline> & { error?: string };

      if (!response.ok || payload.error || !payload.slides || !payload.deckTitle) {
        setMessage(payload.error ?? "Outline failed.");
        return;
      }

      const generatedSlides: Slide[] = payload.slides.map((s) => ({
        id: crypto.randomUUID(),
        name: s.name,
        prompt: s.prompt,
        note: s.notes,
        suggestedFormat: s.suggestedFormat,
        status: "idle"
      }));

      setSlides(generatedSlides);
      setSelectedId(generatedSlides[0]?.id ?? "");
      setBriefOpen(false);
      setBriefText("");
      setMessage(
        `Generated ${generatedSlides.length}-slide outline: "${payload.deckTitle}". Click Cook on each slide to fill it in.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Outline failed.");
    } finally {
      setBriefRunning(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <p className="eyebrow">Valon Take-home</p>
          <h1>Slides</h1>
          <button
            className="loud-button"
            onClick={() => setBriefOpen(true)}
            type="button"
            disabled={cookingAll || briefRunning}
          >
            From brief ✨
          </button>

          {(() => {
            const idleCount = slides.filter(
              (s) => s.status !== "done" && s.status !== "working"
            ).length;
            const errorCount = slides.filter((s) => s.status === "error").length;
            const workingCount = slides.filter((s) => s.status === "working").length;

            if (cookingAll) {
              return (
                <button
                  className="ghost-button stop-button"
                  onClick={cancelCookAll}
                  type="button"
                >
                  Stop ({workingCount} running)
                </button>
              );
            }

            return (
              <>
                <button
                  className="ghost-button"
                  onClick={() => {
                    void cookAllSlides();
                  }}
                  type="button"
                  disabled={idleCount === 0}
                >
                  Cook all{idleCount ? ` (${idleCount})` : ""}
                </button>
                {errorCount > 0 && (
                  <button
                    className="ghost-button retry-button"
                    onClick={() => {
                      void cookAllSlides({ onlyFailed: true });
                    }}
                    type="button"
                  >
                    Retry failed ({errorCount})
                  </button>
                )}
              </>
            );
          })()}

          <button className="ghost-button" onClick={addSlide} type="button">
            Box +
          </button>
        </div>

        <div className="theme-card">
          <p className="eyebrow">Theme</p>
          <div className="theme-chips" role="group" aria-label="Theme picker">
            {PRESET_THEME_LIST.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-chip ${theme.id === t.id ? "active" : ""}`}
                onClick={() => setTheme(t)}
                title={t.blurb}
              >
                <span className="theme-swatch" aria-hidden>
                  <span style={{ background: t.cssVars.paper }} />
                  <span style={{ background: t.cssVars.ink }} />
                  <span style={{ background: t.cssVars.accent }} />
                </span>
                <span>{t.name}</span>
              </button>
            ))}
          </div>
          {theme.id === "locked" && (
            <div className="theme-locked-row">
              <span className="theme-locked-label" title={theme.blurb}>
                ⚲ {theme.name}
              </span>
              <button
                className="theme-unlock"
                type="button"
                onClick={() => setTheme(DEFAULT_THEME)}
              >
                unlock
              </button>
            </div>
          )}
          <button
            className="ghost-button theme-lock-button"
            type="button"
            disabled={!selectedSlide?.imageData || lockingStyle}
            onClick={() => {
              void lockStyleFromSelectedSlide();
            }}
            title={
              selectedSlide?.imageData
                ? "Use this slide's palette + style for the rest of the deck"
                : "Cook an image slide first, then lock its style"
            }
          >
            {lockingStyle ? "reading..." : "Lock style from this slide"}
          </button>
        </div>

        <div className="slide-list">
          {slides.map((slide, index) => (
            <button
              className={`thumb ${slide.id === selectedSlide?.id ? "active" : ""}`}
              key={slide.id}
              onClick={() => setSelectedId(slide.id)}
              type="button"
            >
              <div className="thumb-art">
                {slide.imageData ? (
                  <img alt={slide.name} src={slide.imageData} />
                ) : slide.layout ? (
                  <div className="thumb-layout-preview">
                    <span className="thumb-layout-kind">{slide.layout.kind}</span>
                    <span className="thumb-layout-headline">
                      {getLayoutHeadline(slide.layout)}
                    </span>
                  </div>
                ) : (
                  <span>empty-ish</span>
                )}
              </div>
              <div className="thumb-copy">
                <strong>
                  {index + 1}. {slide.name}
                </strong>
                <span>{slide.status}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="editor">
        <div className="top-strip">
          <div>
            <p className="eyebrow">Current page</p>
            <input
              className="name-input"
              onChange={(event) =>
                selectedSlide && patchSlide(selectedSlide.id, { name: event.target.value })
              }
              placeholder="Whatever this slide is called"
              value={selectedSlide?.name ?? ""}
            />
          </div>

          <div className="top-actions">
            <button
              className="ghost-button"
              onClick={() => selectedSlide && killSlide(selectedSlide.id)}
              type="button"
            >
              toss
            </button>
            <button className="ghost-button weird-button" onClick={addSlide} type="button">
              another one
            </button>
            <button
              className="loud-button"
              onClick={openPresenter}
              disabled={!slides.length}
              type="button"
              title="Present (Esc to exit, arrows to navigate, N for notes)"
            >
              Present ▶
            </button>
            <button
              className="ghost-button"
              disabled={exporting}
              onClick={exportDeck}
              type="button"
            >
              {exporting ? "packing..." : "PPT-ish"}
            </button>
          </div>
        </div>

        <div className="canvas-wrap">
          <div className="canvas-card">
            {selectedSlide?.kind === "layout" && selectedSlide.layout ? (
              <LayoutSlide layout={selectedSlide.layout} />
            ) : selectedSlide?.imageData ? (
              <img alt={selectedSlide.name} className="slide-image" src={selectedSlide.imageData} />
            ) : (
              <div className="empty-state">
                <p>No image yet.</p>
                <span>Prompt it and something should show up here.</span>
              </div>
            )}
          </div>

          <div className="floating-chip">
            <span>{selectedSlide?.status ?? "idle"}</span>
            <span>{selectedSlide?.feedback ?? "Waiting around."}</span>
          </div>
        </div>

        <div className="bottom-mess">
          <div className="prompt-card">
            <label className="field-label" htmlFor="prompt-box">
              Scene request maybe
            </label>
            <textarea
              id="prompt-box"
              onChange={(event) =>
                selectedSlide && patchSlide(selectedSlide.id, { prompt: event.target.value })
              }
              placeholder="Describe the slide. The AI decides if it should be an image or a text layout."
              rows={7}
              value={selectedSlide?.prompt ?? ""}
            />
          </div>

          <div className="side-controls">
            <label className="field-label" htmlFor="format-select">
              Force a format
            </label>
            <div className="format-chips" id="format-select">
              {FORMAT_OPTIONS.map((option) => {
                const currentFormat = selectedSlide?.suggestedFormat ?? "auto";
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`format-chip ${currentFormat === option.value ? "active" : ""}`}
                    onClick={() =>
                      selectedSlide &&
                      patchSlide(selectedSlide.id, { suggestedFormat: option.value })
                    }
                    disabled={selectedSlide?.status === "working"}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <button
              className="loud-button"
              disabled={selectedSlide?.status === "working"}
              onClick={() => {
                void generateSlide(false);
              }}
              type="button"
            >
              {selectedSlide?.status === "working" ? "wait" : "Cook"}
            </button>
            <button
              className="ghost-button"
              disabled={selectedSlide?.status === "working"}
              onClick={() => {
                void generateSlide(true);
              }}
              type="button"
            >
              Again
            </button>
            <button
              className="ghost-button"
              disabled={
                selectedSlide?.status !== "done" ||
                selectedSlide.critiquing ||
                (!selectedSlide.imageData && !selectedSlide.layout)
              }
              onClick={() => {
                if (selectedSlide?.critique) {
                  setCritiquePanelOpen(true);
                } else {
                  void critiqueSelectedSlide();
                }
              }}
              type="button"
              title="Get specific, blunt feedback from a presentation coach"
            >
              {selectedSlide?.critiquing
                ? "thinking..."
                : selectedSlide?.critique
                ? "View critique"
                : "Critique"}
            </button>
            <label className="field-label" htmlFor="note-box">
              Tiny note gutter
            </label>
            <textarea
              id="note-box"
              onChange={(event) =>
                selectedSlide && patchSlide(selectedSlide.id, { note: event.target.value })
              }
              placeholder="Notes, maybe."
              rows={5}
              value={selectedSlide?.note ?? ""}
            />
          </div>
        </div>

        <div className="status-bar">{message}</div>
      </section>

      {presenterOpen && slides[presenterIndex] && (() => {
        const slide = slides[presenterIndex];
        const isFirst = presenterIndex === 0;
        const isLast = presenterIndex === slides.length - 1;

        return (
          <div className="presenter-overlay" onClick={(e) => {
            if (e.target === e.currentTarget) {
              setPresenterIndex((i) => Math.min(slides.length - 1, i + 1));
            }
          }}>
            <div className="presenter-stage">
              {slide.kind === "layout" && slide.layout ? (
                <LayoutSlide layout={slide.layout} />
              ) : slide.imageData ? (
                <img alt={slide.name} className="presenter-image" src={slide.imageData} />
              ) : (
                <div className="presenter-empty">
                  <p>{slide.name}</p>
                  <span>This slide hasn't been cooked yet. Press Esc to exit.</span>
                </div>
              )}
            </div>

            <div className="presenter-chrome">
              <button
                className="presenter-nav presenter-prev"
                onClick={() => setPresenterIndex((i) => Math.max(0, i - 1))}
                disabled={isFirst}
                aria-label="Previous slide"
                type="button"
              >
                ←
              </button>

              <div className="presenter-counter">
                {presenterIndex + 1} / {slides.length}
              </div>

              <button
                className="presenter-nav presenter-next"
                onClick={() => setPresenterIndex((i) => Math.min(slides.length - 1, i + 1))}
                disabled={isLast}
                aria-label="Next slide"
                type="button"
              >
                →
              </button>

              <button
                className="presenter-action"
                onClick={() => setPresenterShowNotes((v) => !v)}
                type="button"
                title="Toggle speaker notes (N)"
              >
                {presenterShowNotes ? "hide notes" : "notes"}
              </button>

              <button
                className="presenter-action presenter-exit"
                onClick={() => setPresenterOpen(false)}
                type="button"
                title="Exit presenter (Esc)"
              >
                exit ✕
              </button>
            </div>

            {presenterShowNotes && slide.note && (
              <div className="presenter-notes">
                <p className="eyebrow">Speaker notes</p>
                <p>{slide.note}</p>
              </div>
            )}
          </div>
        );
      })()}

      {briefOpen && (
        <div
          className="brief-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget && !briefRunning) {
              setBriefOpen(false);
            }
          }}
        >
          <div className="brief-panel">
            <p className="eyebrow">Generate from a brief</p>
            <h2 className="brief-title">Spell out the deck.</h2>
            <p className="brief-help">
              Audience, purpose, tone, key points. The AI will draft an outline — title, slide names,
              prompts, and speaker notes — picking image vs layout for each slide.
            </p>

            <label className="field-label" htmlFor="brief-textarea">
              The brief
            </label>
            <textarea
              id="brief-textarea"
              className="brief-textarea"
              rows={9}
              placeholder="e.g. 7-slide pitch for a B2B SaaS that automates expense reports for SMBs. Audience: seed-stage VCs. Tone: confident, data-driven, slightly cheeky. Hit the problem, the wedge, the numbers, and the ask."
              value={briefText}
              onChange={(event) => setBriefText(event.target.value)}
              disabled={briefRunning}
            />

            <div className="brief-row">
              <label className="field-label" htmlFor="brief-count">
                # of slides (blank = AI picks)
              </label>
              <input
                id="brief-count"
                type="number"
                className="brief-count-input"
                min={1}
                max={20}
                value={briefSlideCount}
                onChange={(event) => {
                  const v = event.target.value;
                  setBriefSlideCount(v === "" ? "" : Math.max(1, Math.min(20, Number(v))));
                }}
                disabled={briefRunning}
              />
            </div>

            <div className="brief-actions">
              <button
                className="ghost-button"
                onClick={() => setBriefOpen(false)}
                disabled={briefRunning}
                type="button"
              >
                cancel
              </button>
              <button
                className="loud-button"
                onClick={() => {
                  void generateFromBrief();
                }}
                disabled={briefRunning || !briefText.trim()}
                type="button"
              >
                {briefRunning ? "drafting..." : "Generate deck"}
              </button>
            </div>

            <p className="brief-warn">Heads up: this replaces all current slides.</p>
          </div>
        </div>
      )}

      {critiquePanelOpen && selectedSlide?.critique && (
        <aside className="critique-drawer" role="complementary" aria-label="Slide critique">
          <header className="critique-header">
            <div>
              <p className="eyebrow">Critique</p>
              <h2 className="critique-title">{selectedSlide.name}</h2>
            </div>
            <button
              className="critique-close"
              onClick={() => setCritiquePanelOpen(false)}
              aria-label="Close critique"
              type="button"
            >
              ✕
            </button>
          </header>

          <div className={`critique-overall critique-overall-${selectedSlide.critique.overall}`}>
            <span className="critique-verdict">{selectedSlide.critique.overall}</span>
            <p className="critique-summary">{selectedSlide.critique.summary}</p>
          </div>

          {selectedSlide.critique.strengths.length > 0 && (
            <section className="critique-section">
              <p className="eyebrow">Working</p>
              <ul className="critique-strengths">
                {selectedSlide.critique.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}

          {selectedSlide.critique.issues.length > 0 && (
            <section className="critique-section">
              <p className="eyebrow">Issues ({selectedSlide.critique.issues.length})</p>
              <ul className="critique-issues">
                {selectedSlide.critique.issues.map((issue, i) => (
                  <li key={i} className={`critique-issue critique-issue-${issue.severity}`}>
                    <div className="critique-issue-meta">
                      <span className="critique-severity">{issue.severity}</span>
                      <span className="critique-area">{issue.area}</span>
                    </div>
                    <p className="critique-message">{issue.message}</p>
                    {issue.suggestion && (
                      <p className="critique-suggestion">→ {issue.suggestion}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <footer className="critique-footer">
            <button
              className="ghost-button"
              onClick={() => {
                if (selectedSlide) patchSlide(selectedSlide.id, { critique: undefined });
                void critiqueSelectedSlide();
              }}
              disabled={selectedSlide?.critiquing}
              type="button"
            >
              {selectedSlide?.critiquing ? "thinking..." : "Re-critique"}
            </button>
          </footer>
        </aside>
      )}
    </main>
  );
}
