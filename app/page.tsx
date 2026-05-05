"use client";

import { useEffect, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { elapsedSeconds, workingHint } from "@/lib/ui/working-feedback";
import { slideThumbnailHeading } from "@/lib/ui/slide-thumbnail-heading";
import { TEMPLATE_LIST, type Template } from "@/lib/templates";
import { HistoryStack } from "@/lib/history/stack";
import { normalizeFormat } from "@/lib/ai/helpers";
import { decodeDeckHash, encodeDeckHash, toSharePayload } from "@/lib/share/deck-url";
import { isVoiceSupported, startVoiceRecognition, type VoiceController } from "@/lib/voice/recognition";

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
  /** Epoch ms when this slide entered the "working" state. Used to render an
   * elapsed-time counter and to drive the shimmer animation. Cleared on done/error. */
  startedAt?: number;
  /** Up to 3 alternate image renders from "3 variants". Pick one to keep as `imageData`. */
  imageVariants?: Array<{ imageData: string; reasoning?: string }>;
  /** Which entry in `imageVariants` is selected (0..2). Kept in sync with `imageData`. */
  imageVariantPick?: number;
};

/** Restored decks can persist `working` with no attached fetch — normalize so the UI isn't stuck. */
function normalizeSlidesAfterLoad(slides: Slide[]): Slide[] {
  return slides.map((s) => {
    let next: Slide = s;
    if (s.status === "working") {
      next = {
        ...s,
        status: "idle",
        startedAt: undefined,
        critiquing: undefined,
        feedback: "Reloaded during generation — press Cook to retry."
      };
    }
    if (next.critiquing) {
      next = { ...next, critiquing: undefined };
    }
    return next;
  });
}

function slideDisplayImage(slide: Slide | undefined): string | undefined {
  if (!slide) return undefined;
  const variants = slide.imageVariants;
  const pick = slide.imageVariantPick ?? 0;
  if (variants && variants.length > 0) {
    return variants[pick]?.imageData ?? slide.imageData;
  }
  return slide.imageData;
}

/** True when the slide already has layout or image pixels (brief UI can hide). */
function slideHasRenderedContent(slide: Slide | undefined): boolean {
  if (!slide) return false;
  if (slide.kind === "layout" && slide.layout) return true;
  return Boolean(slideDisplayImage(slide));
}

/** Snapshot persisted in the undo/redo stack. Includes selectedId so undo
 * restores the cursor too — reordering then undoing without restoring the
 * selection feels disorienting. */
type DeckSnapshot = {
  slides: Slide[];
  selectedId: string;
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

const STORAGE_KEY = "valon-presentation-takehome-v6";

/** Default first-slide prompt — must match `makeSlide(0)` for starter detection. */
const DEFAULT_STARTER_SLIDE_PROMPT =
  "An editorial title slide for a mortgage startup, with a single hero image and a confident headline";

/** localStorage quota is tight (typically ~5MB per origin); base64 images blow past quickly. */
const LS_APPROX_SAFE_BYTES = 4_250_000;

/** Avoid blocking the main thread on every React commit while drafting prompts. */
const STORAGE_DEBOUNCE_MS = 480;

/** If /api/generate never returns (network stall, CDN hang), unblock the spinner. */
const GEN_FETCH_TIMEOUT_MS = 150_000;

function jsonUtf8ByteLength(json: string): number {
  return new Blob([json]).size;
}

function isQuotaExceededError(e: unknown): boolean {
  if (e instanceof DOMException) {
    if (e.code === DOMException.QUOTA_EXCEEDED_ERR || e.code === 22) return true;
    if (e.name === "QuotaExceededError") return true;
  }
  if (!e || typeof e !== "object") return false;
  const o = e as { code?: unknown; name?: unknown };
  return (
    o.name === "QuotaExceededError" ||
    o.code === 22 ||
    o.code === DOMException.QUOTA_EXCEEDED_ERR
  );
}

/** Combine user/batch AbortSignal with another (e.g. timeout). */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const out = new AbortController();
  const forward = (): void => {
    out.abort();
  };
  if (a.aborted || b.aborted) {
    forward();
    return out.signal;
  }
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return out.signal;
}

function createGenerationFetchSignal(signal?: AbortSignal): {
  signal: AbortSignal;
  release: () => void;
} {
  const timeoutCtl = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutCtl.abort(), GEN_FETCH_TIMEOUT_MS);
  const effective = signal ? mergeAbortSignals(signal, timeoutCtl.signal) : timeoutCtl.signal;
  return {
    signal: effective,
    release: () => window.clearTimeout(timeoutId)
  };
}

/** Drop image payloads for persistence; former image-done slides reopen as idle after reload. */
function slidesForLimitedStorage(slides: Slide[]): Slide[] {
  return slides.map((slide) => {
    const hadPixels = !!(
      (slide.imageData && slide.imageData.length > 0) ||
      (slide.imageVariants && slide.imageVariants.some((v) => v.imageData?.length))
    );

    let next: Slide = {
      ...slide,
      imageData: undefined,
      imageVariants: undefined,
      imageVariantPick: undefined
    };

    if (hadPixels && slide.kind === "image" && !slide.layout) {
      next.kind = undefined;
      if (slide.status === "done" || slide.status === "error") {
        next.status = "idle";
      }
      next.critique = undefined;
      next.critiquing = undefined;
      next.feedback = undefined;
      next.startedAt = undefined;
    }

    return next;
  });
}

function makeSlide(index: number): Slide {
  return {
    id: crypto.randomUUID(),
    name: `Slide ${index + 1}`,
    prompt: index === 0 ? DEFAULT_STARTER_SLIDE_PROMPT : "",
    status: "idle",
    note: ""
  };
}

function starterSlides(): Slide[] {
  return [makeSlide(0), makeSlide(1)];
}

/** True only for the untouched two-slide starter scaffold ( IDs may differ ). */
function isPristineStarterDeck(slides: Slide[]): boolean {
  if (slides.length !== 2) return false;
  const [a, b] = slides;
  return (
    a.name === "Slide 1" &&
    b.name === "Slide 2" &&
    a.prompt === DEFAULT_STARTER_SLIDE_PROMPT &&
    b.prompt === "" &&
    (a.note ?? "") === "" &&
    (b.note ?? "") === "" &&
    a.status === "idle" &&
    b.status === "idle" &&
    a.suggestedFormat === undefined &&
    b.suggestedFormat === undefined &&
    a.kind === undefined &&
    b.kind === undefined &&
    a.layout === undefined &&
    b.layout === undefined
  );
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

/**
 * Draggable sidebar thumbnail. Pointer sensor uses an 8-px activation
 * distance so single clicks still pass through to onClick (the slide-select
 * handler) — only intentional drags trigger reordering. Keyboard reordering
 * works too: focus a thumb and use Space + arrow keys.
 */
function SortableThumb({
  slide,
  index,
  isActive,
  onClick,
  onDelete,
  deleteDisabled,
  deleteTitle
}: {
  slide: Slide;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
  deleteTitle: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id
  });
  const isWorking = slide.status === "working";
  const elapsed = elapsedSeconds(slide.startedAt, Date.now());
  const thumbSrc = slideDisplayImage(slide);
  const thumbHeading = slideThumbnailHeading(slide);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`thumb-shell ${isActive ? "active" : ""} ${isDragging ? "is-dragging" : ""}`}
    >
      <button
        type="button"
        className="thumb-delete"
        aria-label={`Delete slide: ${thumbHeading}`}
        title={deleteTitle}
        disabled={deleteDisabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (!deleteDisabled) {
            onDelete();
          }
        }}
      >
        ×
      </button>
      <button
        className={`thumb ${isWorking ? "is-working" : ""} status-${slide.status}`}
        onClick={onClick}
        type="button"
        {...attributes}
        {...listeners}
      >
        <div className="thumb-art">
          {thumbSrc ?
            <img alt={thumbHeading} src={thumbSrc} draggable={false} />
          : slide.layout ?
            <div className="thumb-layout-clone" aria-hidden>
              <div className="thumb-layout-slot">
                <LayoutSlide layout={slide.layout} />
              </div>
            </div>
          : <span>empty-ish</span>}
          {isWorking && <div className="thumb-shimmer" aria-hidden />}
        </div>
        <div className="thumb-copy">
          <strong className="thumb-heading" title={thumbHeading}>
            {thumbHeading}
          </strong>
          <span>{isWorking ? `${elapsed}s` : slide.status}</span>
        </div>
      </button>
    </div>
  );
}

export default function Home() {
  const [slides, setSlides] = useState<Slide[]>(starterSlides);
  const [selectedId, setSelectedId] = useState<string>("");
  const [message, setMessage] = useState("");
  /** When false, defer localStorage writes until share-link / persisted deck hydration finishes — avoids overwriting saved data or burning main-thread time on SSR placeholder state. */
  const [hydrationDone, setHydrationDone] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefText, setBriefText] = useState("");
  const [briefSlideCount, setBriefSlideCount] = useState<number | "">(7);
  const [briefRunning, setBriefRunning] = useState(false);
  /**
   * When true: deck starters + preset themes are tucked away. User reopens via
   * the Theme summary control; brief stays on "Brief / templates".
   */
  const [deckScaffoldMinimized, setDeckScaffoldMinimized] = useState(false);

  const [cookingAll, setCookingAll] = useState(false);
  const cookAbortRef = useRef<AbortController | null>(null);
  /** AbortController for single-slide Cook / Again when not in Cook all pool. */
  const soloCookAbortRef = useRef<AbortController | null>(null);
  /** AbortController shared by parallel fetches for "3 looks". */
  const variantsAbortRef = useRef<AbortController | null>(null);
  /** Per-slide monotonic generation id — bumped on cancel / new cook so stale fetches skip patchSlide. */
  const cookGenRef = useRef<Record<string, number>>({});
  /** Per-slide drafts for the AI edit box (right rail); not persisted. */
  const slideEditDraftRef = useRef<Record<string, string>>({});

  function bumpCookGen(slideId: string): number {
    const next = (cookGenRef.current[slideId] ?? 0) + 1;
    cookGenRef.current[slideId] = next;
    return next;
  }

  function isStaleCookGen(slideId: string, token: number): boolean {
    return cookGenRef.current[slideId] !== token;
  }

  const [presenterOpen, setPresenterOpen] = useState(false);
  const [presenterIndex, setPresenterIndex] = useState(0);
  const [presenterShowNotes, setPresenterShowNotes] = useState(false);
  const [critiquePanelOpen, setCritiquePanelOpen] = useState(false);
  /** Active deck theme. Either a preset (selected via the theme picker) or
   * a "locked" theme extracted from a generated image slide. Persisted to
   * localStorage so reloads preserve the look. */
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [lockingStyle, setLockingStyle] = useState(false);
  /** Bumps every 500ms while at least one slide is working. Forces a re-render
   * so the elapsed-time counters keep climbing. State value itself is unused
   * — only its identity matters to React. */
  const [, setTick] = useState(0);

  // dnd-kit: 8-px activation distance lets clicks pass through; only
  // intentional drags trigger reorder. Keyboard sortable for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /**
   * Undo/redo stack. Snapshots before structural mutations only:
   * add/kill/reorder/template/brief/style-lock. Inline text edits (name,
   * notes, prompt) are excluded — those would explode the history with
   * per-keystroke entries, and the textarea's native Cmd+Z covers them.
   * `historyVersion` bumps after every history op so the Undo/Redo
   * button disabled state re-evaluates on each render.
   */
  const historyRef = useRef(new HistoryStack<DeckSnapshot>(50));
  const [, bumpHistory] = useState(0);

  /** Bumped when the deck is wiped (reset); blocks stale brief/template completions. */
  const deckEpochRef = useRef(0);

  const [voiceBriefListening, setVoiceBriefListening] = useState(false);
  const voiceBriefBaselineRef = useRef("");
  const voiceBriefControllerRef = useRef<VoiceController | null>(null);

  /** Prevents repeating the storage-quota footer on every keystroke re-persist. */
  const persistModeRef = useRef<"lite-size" | "lite-quota" | "failed" | null>(null);

  function stopVoiceBrief() {
    voiceBriefControllerRef.current?.stop();
    voiceBriefControllerRef.current = null;
    setVoiceBriefListening(false);
  }

  useEffect(() => {
    return () => {
      voiceBriefControllerRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!briefOpen) {
      voiceBriefBaselineRef.current = "";
      stopVoiceBrief();
    }
  }, [briefOpen]);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const rawHash =
          typeof window !== "undefined" && window.location.hash.startsWith("#share=")
            ? window.location.hash.slice("#share=".length)
            : "";

        if (rawHash) {
          const decoded = await decodeDeckHash(rawHash);
          if (cancelled) return;
          if (
            decoded &&
            decoded.theme?.cssVars &&
            decoded.theme?.pptx &&
            decoded.slides?.length
          ) {
            const nextSlides: Slide[] = decoded.slides.map((s) => ({
              id: typeof s.id === "string" && s.id.length > 0 ? s.id : crypto.randomUUID(),
              name: s.name ?? "",
              prompt: s.prompt ?? "",
              note: s.note ?? "",
              suggestedFormat: normalizeFormat(s.suggestedFormat),
              kind: s.kind === "image" || s.kind === "layout" ? s.kind : undefined,
              layout: (s.layout ?? undefined) as SlideLayout | undefined,
              status: "idle",
              critique: undefined,
              critiquing: undefined,
              startedAt: undefined,
              imageVariants: undefined,
              imageVariantPick: undefined
            }));
            const selId = nextSlides.some((sl) => sl.id === decoded.selectedId)
              ? decoded.selectedId
              : (nextSlides[0]?.id ?? "");
            setSlides(nextSlides);
            setSelectedId(selId);
            setTheme(decoded.theme as Theme);
            setDeckScaffoldMinimized(true);
            historyRef.current.reset();
            bumpHistory((n) => n + 1);
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
            setMessage("Loaded deck from share link (images not included).");
            return;
          }
        }

        if (cancelled) return;

        const saved = window.localStorage.getItem(STORAGE_KEY);

        if (!saved) {
          const fresh = starterSlides();
          setSlides(fresh);
          setSelectedId(fresh[0]?.id ?? "");
          setDeckScaffoldMinimized(false);
          return;
        }

        try {
          const parsed = JSON.parse(saved) as {
            slides: Slide[];
            selectedId: string;
            theme?: Theme;
            deckScaffoldMinimized?: boolean;
          };

          if (parsed.slides?.length) {
            const normalized = normalizeSlidesAfterLoad(parsed.slides);
            setSlides(normalized);
            setSelectedId(parsed.selectedId || parsed.slides[0].id);
            const stored =
              typeof parsed.deckScaffoldMinimized === "boolean" ?
                parsed.deckScaffoldMinimized
              : null;
            setDeckScaffoldMinimized(
              stored !== null ? stored : !isPristineStarterDeck(normalized)
            );
          }
          if (parsed.theme && parsed.theme.cssVars && parsed.theme.pptx) {
            setTheme(parsed.theme);
          }
        } catch {
          const fresh = starterSlides();
          setSlides(fresh);
          setSelectedId(fresh[0]?.id ?? "");
          setDeckScaffoldMinimized(false);
        }
      } catch {
        if (!cancelled) {
          const fresh = starterSlides();
          setSlides(fresh);
          setSelectedId(fresh[0]?.id ?? "");
          setDeckScaffoldMinimized(false);
        }
      } finally {
        if (!cancelled) {
          setHydrationDone(true);
        }
      }
    }

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrationDone || !slides.length) {
      return;
    }

    const savedTimer = window.setTimeout(() => {
      const sel = selectedId || slides[0].id;
      const fullJson = JSON.stringify({
        slides,
        selectedId: sel,
        theme,
        deckScaffoldMinimized
      });
      const liteJson = JSON.stringify({
        slides: slidesForLimitedStorage(slides),
        selectedId: sel,
        theme,
        lite: true,
        deckScaffoldMinimized
      });

      let pendingLiteReason: "lite-size" | "lite-quota" | null = null;

      try {
        if (jsonUtf8ByteLength(fullJson) <= LS_APPROX_SAFE_BYTES) {
          window.localStorage.setItem(STORAGE_KEY, fullJson);
          persistModeRef.current = null;
          return;
        }
        pendingLiteReason = "lite-size";
      } catch (e) {
        if (!isQuotaExceededError(e)) {
          console.error(e);
          return;
        }
        pendingLiteReason = "lite-quota";
      }

      try {
        window.localStorage.setItem(STORAGE_KEY, liteJson);
        const mode = pendingLiteReason ?? "lite-size";
        if (persistModeRef.current !== mode) {
          persistModeRef.current = mode;
          setMessage(
            mode === "lite-size" ?
              "Deck snapshot is large — saved outlines and layout slides only so browser storage stays under quota. Images stay in this tab until you close it; export PPTX or Share link before reload, or Cook again afterward."
            : "Browser storage was full — saved text and layouts without image bytes. This session still shows images until you reload."
          );
        }
      } catch (e2) {
        console.error(e2);
        if (persistModeRef.current !== "failed") {
          persistModeRef.current = "failed";
          setMessage(
            "Could not save locally (storage full). Keep this tab open or clear site data for this origin — export PPTX if you need a backup."
          );
        }
      }
    }, STORAGE_DEBOUNCE_MS);

    return () => window.clearTimeout(savedTimer);
  }, [slides, selectedId, theme, hydrationDone, deckScaffoldMinimized]);

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

  // Drive the elapsed-time counters while any slide is in flight.
  useEffect(() => {
    const anyWorking = slides.some((s) => s.status === "working");
    if (!anyWorking) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, [slides]);

  const selectedSlide = slides.find((slide) => slide.id === selectedId) ?? slides[0];

  useEffect(() => {
    if (!selectedSlide && slides[0]) {
      setSelectedId(slides[0].id);
    }
  }, [selectedSlide, slides]);

  /**
   * Global Cmd+Z / Cmd+Shift+Z (and Ctrl+Z on non-mac) for undo/redo. We
   * skip when focus is in an input/textarea/contenteditable so the
   * platform's native text undo continues to work — that's both expected
   * by users and avoids fighting the browser for plain text editing.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const isModified = event.metaKey || event.ctrlKey;
      if (!isModified || event.key.toLowerCase() !== "z") return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;

      event.preventDefault();
      if (event.shiftKey) {
        doRedo();
      } else {
        doUndo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // doUndo/doRedo close over slides + selectedId; refresh listener when
    // those change so we always operate on current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, selectedId]);

  function patchSlide(id: string, patch: Partial<Slide>) {
    setSlides((current) =>
      current.map((slide) => (slide.id === id ? { ...slide, ...patch } : slide))
    );
  }

  function addSlide() {
    snapshotForUndo();
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

    snapshotForUndo();
    const nextSlides = slides.filter((slide) => slide.id !== id);
    setSlides(nextSlides);

    if (selectedId === id) {
      setSelectedId(nextSlides[0]?.id ?? "");
    }

    setMessage("A page vanished.");
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    snapshotForUndo();
    setSlides((current) => {
      const oldIndex = current.findIndex((s) => s.id === active.id);
      const newIndex = current.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  }

  /** Capture the current deck state on the undo stack. Call this BEFORE
   * any structural mutation (add/kill/reorder/template/brief). */
  function snapshotForUndo() {
    historyRef.current.snapshot({ slides, selectedId });
    bumpHistory((n) => n + 1);
  }

  function doUndo() {
    const restored = historyRef.current.undo({ slides, selectedId });
    if (!restored) return;
    setSlides(restored.slides);
    setSelectedId(restored.selectedId);
    bumpHistory((n) => n + 1);
    setMessage("Undone.");
  }

  function doRedo() {
    const restored = historyRef.current.redo({ slides, selectedId });
    if (!restored) return;
    setSlides(restored.slides);
    setSelectedId(restored.selectedId);
    bumpHistory((n) => n + 1);
    setMessage("Redone.");
  }

  /**
   * Cook one slide. Patches the slide's status as it progresses. Used by both
   * the single-slide "Cook" button and the batch "Cook all" flow.
   */
  async function cookOneSlide(
    slide: Slide,
    options: { variation?: boolean; signal?: AbortSignal; editInstruction?: string } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    const { variation = false, signal, editInstruction } = options;
    const instr = editInstruction?.trim();
    const isEdit = Boolean(instr);

    if (!isEdit && !slide.prompt.trim()) {
      patchSlide(slide.id, { status: "error", feedback: "No prompt." });
      return { ok: false, reason: "No prompt." };
    }

    if (isEdit) {
      const hasLayout = slide.kind === "layout" && slide.layout;
      const hasImage = Boolean(slideDisplayImage(slide));
      if (!hasLayout && !hasImage && !slide.prompt.trim()) {
        patchSlide(slide.id, {
          status: "error",
          feedback: "Cook this slide or add a brief before asking for AI edits."
        });
        return { ok: false, reason: "Nothing to edit yet." };
      }
    }

    const slideFormat: FormatOverride = slide.suggestedFormat ?? "auto";
    const formatLabel =
      slideFormat === "auto" ? "best format" : `${slideFormat} layout`;
    patchSlide(slide.id, {
      status: "working",
      startedAt: Date.now(),
      imageVariants: undefined,
      imageVariantPick: undefined,
      feedback:
        isEdit ? "Applying your edit..."
        : variation ? "Trying a different take..."
        : `Figuring out the ${formatLabel}...`
    });

    const gen = bumpCookGen(slide.id);
    const ownsSolo = signal === undefined;
    const soloCtl = ownsSolo ? new AbortController() : null;
    if (soloCtl) {
      soloCookAbortRef.current = soloCtl;
    }
    const upstream = signal ?? soloCtl!.signal;
    const { signal: fetchSignal, release } = createGenerationFetchSignal(upstream);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: fetchSignal,
        body: JSON.stringify({
          prompt: slide.prompt,
          variation: isEdit ? false : variation,
          formatOverride: slideFormat,
          // Image generations get the active theme's appendix so the deck
          // stays visually coherent. Layout slides ignore this server-side.
          styleAppendix: theme.imagePromptAppendix,
          ...(isEdit && instr
            ? {
                editInstruction: instr,
                existingLayout: slide.kind === "layout" ? slide.layout : undefined,
                referenceImageData: slideDisplayImage(slide),
                slideTitle: slide.name
              }
            : {})
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

      if (isStaleCookGen(slide.id, gen)) {
        return { ok: false, reason: "cancelled" };
      }

      if (!response.ok || payload.error) {
        patchSlide(slide.id, {
          status: "error",
          startedAt: undefined,
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
          startedAt: undefined,
          feedback: undefined
        });
        return { ok: true };
      }

      if (payload.kind === "image" && payload.imageData) {
        patchSlide(slide.id, {
          kind: "image",
          imageData: payload.imageData,
          layout: undefined,
          imageVariants: undefined,
          imageVariantPick: undefined,
          status: "done",
          startedAt: undefined,
          feedback: undefined
        });
        return { ok: true };
      }

      patchSlide(slide.id, {
        status: "error",
        startedAt: undefined,
        feedback: "Unexpected response from generator."
      });
      return { ok: false, reason: "Unexpected response from generator." };
    } catch (err) {
      if (isStaleCookGen(slide.id, gen)) {
        return { ok: false, reason: "cancelled" };
      }
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const userStopped =
        isAbort &&
        (Boolean(signal?.aborted) || Boolean(soloCtl?.signal.aborted));
      patchSlide(slide.id, {
        status: userStopped ? "idle" : "error",
        startedAt: undefined,
        feedback:
          userStopped ? "Cancelled."
          : isAbort ? "Timed out waiting for the model — try Cook again."
          : err instanceof Error ? err.message
          : "Network error."
      });
      return {
        ok: false,
        reason: userStopped ? "cancelled" : isAbort ? "timed out" : "network error"
      };
    } finally {
      release();
      if (ownsSolo && soloCtl && soloCookAbortRef.current === soloCtl) {
        soloCookAbortRef.current = null;
      }
    }
  }

  /** Generate (no content yet), refresh (have content, empty instructions), or edit (non-empty instructions). */
  async function applySlidePanelAction() {
    if (!selectedSlide) return;
    if (selectedSlide.status === "working") return;

    const instr = slideEditDraftRef.current[selectedSlide.id]?.trim() ?? "";
    const hasRendered = slideHasRenderedContent(selectedSlide);

    if (!hasRendered && !selectedSlide.prompt.trim()) {
      setMessage("Add a slide brief first.");
      return;
    }

    const useEditFlow = instr.length > 0;
    if (!hasRendered) {
      setMessage("Generating slide…");
    } else if (useEditFlow) {
      setMessage("Applying edit…");
    } else {
      setMessage("Refreshing slide…");
    }

    snapshotForUndo();

    const { ok, reason } = await cookOneSlide(
      selectedSlide,
      useEditFlow ? { editInstruction: instr } : {}
    );

    setMessage(
      ok ?
        useEditFlow ? "Edit applied."
        : hasRendered ? "Slide refreshed."
        : "Slide ready."
      : reason ?? "Generation failed."
    );
  }

  function toggleVoiceBrief() {
    if (voiceBriefListening) {
      stopVoiceBrief();
      return;
    }
    if (!isVoiceSupported()) {
      setMessage("Voice input works in Chrome, Edge, or Safari — not in Firefox.");
      return;
    }
    voiceBriefBaselineRef.current = briefText;
    setVoiceBriefListening(true);
    voiceBriefControllerRef.current = startVoiceRecognition({
      onTranscript: ({ final, interim }) => {
        setBriefText(voiceBriefBaselineRef.current + final + interim);
      },
      onError: (m) => {
        setMessage(m);
        voiceBriefControllerRef.current = null;
        setVoiceBriefListening(false);
      },
      onEnd: () => {
        voiceBriefControllerRef.current = null;
        setVoiceBriefListening(false);
      }
    });
  }

  async function copyShareLink() {
    try {
      const sid = selectedId || slides[0]?.id || "";
      const payload = toSharePayload({ slides, selectedId: sid, theme });
      const enc = await encodeDeckHash(payload);
      if (typeof enc === "object" && "error" in enc) {
        setMessage(enc.error);
        return;
      }
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}#share=${enc}`;
      await navigator.clipboard.writeText(url);
      setMessage("Share link copied. Opens outline + styles — images not included.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't copy link.");
    }
  }

  async function exploreImageVariants() {
    const slide = selectedSlide;
    if (!slide?.prompt.trim()) {
      setMessage("Needs a prompt.");
      return;
    }
    const okFormat =
      slide.suggestedFormat === "image" || slide.kind === "image";
    if (!okFormat) {
      setMessage('Use format "image" or cook an image slide first.');
      return;
    }
    if (slide.status === "working") return;

    snapshotForUndo();

    variantsAbortRef.current?.abort();
    const batch = new AbortController();
    variantsAbortRef.current = batch;

    patchSlide(slide.id, {
      status: "working",
      startedAt: Date.now(),
      imageVariants: undefined,
      imageVariantPick: undefined,
      feedback: "Generating 3 visual variants..."
    });

    const gen = bumpCookGen(slide.id);

    try {
      const body = {
        prompt: slide.prompt,
        formatOverride: "image" as const,
        variation: true,
        styleAppendix: theme.imagePromptAppendix
      };

      const responses = await Promise.all(
        [0, 1, 2].map(async () => {
          const { signal, release } = createGenerationFetchSignal(batch.signal);
          try {
            return await fetch("/api/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal,
              body: JSON.stringify(body)
            });
          } finally {
            release();
          }
        })
      );

      const payloads = await Promise.all(responses.map((r) => r.json()));

      if (isStaleCookGen(slide.id, gen)) {
        return;
      }

      const variants: Array<{ imageData: string; reasoning?: string }> = [];
      for (let i = 0; i < 3; i++) {
        const r = responses[i];
        const p = payloads[i] as {
          error?: string;
          kind?: string;
          imageData?: string;
          reasoning?: string;
        };
        if (!r.ok || p.error || p.kind !== "image" || !p.imageData) {
          if (isStaleCookGen(slide.id, gen)) return;
          patchSlide(slide.id, {
            status: "error",
            startedAt: undefined,
            feedback: p.error ?? `Variant ${i + 1} failed.`
          });
          setMessage(p.error ?? "Variant generation failed.");
          return;
        }
        variants.push({ imageData: p.imageData, reasoning: p.reasoning });
      }

      if (isStaleCookGen(slide.id, gen)) return;

      patchSlide(slide.id, {
        status: "done",
        kind: "image",
        layout: undefined,
        startedAt: undefined,
        imageVariants: variants,
        imageVariantPick: 0,
        imageData: variants[0].imageData,
        feedback: "Pick a variant below."
      });
      setMessage("Three variants ready — tap A, B, or C.");
    } catch (e) {
      if (isStaleCookGen(slide.id, gen)) {
        return;
      }
      const aborted = e instanceof DOMException && e.name === "AbortError";
      const userStopped = aborted && batch.signal.aborted;
      patchSlide(slide.id, {
        status: userStopped ? "idle" : "error",
        startedAt: undefined,
        feedback:
          userStopped ? "Stopped."
          : aborted ? "Timed out waiting for the model."
          : e instanceof Error ? e.message
          : "Network error."
      });
      setMessage(
        userStopped ?
          "Generation stopped."
        : aborted ? "Variant request timed out — try Cook or 3 looks again."
        : e instanceof Error ? e.message
        : "Network error."
      );
    } finally {
      if (variantsAbortRef.current === batch) {
        variantsAbortRef.current = null;
      }
    }
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

  function stopSelectedSlideGeneration() {
    const slide = selectedSlide;
    if (!slide || slide.status !== "working") return;
    if (cookingAll) {
      cancelCookAll();
      return;
    }
    bumpCookGen(slide.id);
    soloCookAbortRef.current?.abort();
    variantsAbortRef.current?.abort();
    patchSlide(slide.id, {
      status: "idle",
      startedAt: undefined,
      feedback: "Stopped.",
    });
    setMessage("Generation stopped.");
  }

  function cancelCookAll() {
    cookAbortRef.current?.abort();
    cookAbortRef.current = null;
    setMessage("Stopping...");
  }

  /**
   * Wipe deck + browser cache for this origin key, reopen defaults, strip #share hashes.
   * Aborts Cook all and shuts overlays so stale async work cannot patch the cleared deck.
   */
  function resetFrontend() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Reset to the starter deck? This clears all slides (including undo history), the saved browser backup, locks, overlays, and any #share= link in the URL."
      )
    ) {
      return;
    }

    cookAbortRef.current?.abort();
    cookAbortRef.current = null;
    soloCookAbortRef.current?.abort();
    soloCookAbortRef.current = null;
    variantsAbortRef.current?.abort();
    variantsAbortRef.current = null;
    cookGenRef.current = {};
    stopVoiceBrief();
    setBriefRunning(false);

    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* quota / privacy mode — still reset in-memory UI */
    }

    if (typeof window !== "undefined" && window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search || "/");
    }

    persistModeRef.current = null;

    deckEpochRef.current += 1;

    const fresh = starterSlides();
    setSlides(fresh);
    setSelectedId(fresh[0]?.id ?? "");
    setTheme(DEFAULT_THEME);
    historyRef.current.reset();
    bumpHistory((n) => n + 1);

    setBriefOpen(false);
    setBriefText("");
    setBriefSlideCount(7);
    setDeckScaffoldMinimized(false);
    setPresenterOpen(false);
    setPresenterShowNotes(false);
    setPresenterIndex(0);
    setCritiquePanelOpen(false);
    setExporting(false);
    setCookingAll(false);
    setLockingStyle(false);

    setMessage("Starter deck restored — local snapshot cleared.");
  }

  /**
   * Run AI critique on a slide. Sends the rendered content (image bytes for
   * image slides, structured layout for layout slides) to the model and
   * stores the result on `slide.critique`. Auto-opens the drawer on success.
   */
  async function critiqueSelectedSlide() {
    if (!selectedSlide) return;
    const displayForCritique =
      slideDisplayImage(selectedSlide) ?? selectedSlide.imageData;
    if (
      selectedSlide.status !== "done" ||
      (!displayForCritique && !selectedSlide.layout)
    ) {
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
          imageData:
            selectedSlide.kind === "image" ?
              (slideDisplayImage(selectedSlide) ?? selectedSlide.imageData)
            : selectedSlide.imageData,
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
    const src = selectedSlide ? slideDisplayImage(selectedSlide) : undefined;
    if (!selectedSlide || !src) {
      setMessage("Lock style only works on a generated image slide.");
      return;
    }

    setLockingStyle(true);
    setMessage("Reading the slide's visual DNA...");

    try {
      const response = await fetch("/api/extract-style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: src })
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

    const epoch = deckEpochRef.current;
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

      if (deckEpochRef.current !== epoch) {
        setMessage("Outline arrived after a reset — ignored.");
        return;
      }

      snapshotForUndo();
      setSlides(generatedSlides);
      setSelectedId(generatedSlides[0]?.id ?? "");
      setBriefOpen(false);
      setBriefText("");
      setDeckScaffoldMinimized(true);
      setMessage(
        `Generated ${generatedSlides.length}-slide outline: "${payload.deckTitle}". Click Cook on each slide to fill it in.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Outline failed.");
    } finally {
      setBriefRunning(false);
    }
  }

  /**
   * Drop a template's slides into the deck. Replaces the current deck (same
   * destructive behavior as deck-from-brief). Templates are deterministic
   * scaffolds — content still needs the user to click Cook all to fill in.
   */
  function applyTemplate(template: Template) {
    const epoch = deckEpochRef.current;

    const generatedSlides: Slide[] = template.slides.map((s) => ({
      id: crypto.randomUUID(),
      name: s.name,
      prompt: s.prompt,
      note: s.notes,
      suggestedFormat: s.suggestedFormat,
      status: "idle"
    }));

    if (deckEpochRef.current !== epoch) {
      return;
    }

    snapshotForUndo();
    setSlides(generatedSlides);
    setSelectedId(generatedSlides[0]?.id ?? "");
    setBriefOpen(false);
    setBriefText("");
    setDeckScaffoldMinimized(true);
    setMessage(
      `Loaded "${template.name}" template (${generatedSlides.length} slides). Click "Cook all" to generate content.`
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <p className="eyebrow">Valon Take-home</p>
          <h1>Slides</h1>

          {deckScaffoldMinimized ?
            <div className="sidebar-deck-sources sidebar-deck-sources--collapsed">
              <button
                type="button"
                className="loud-button sidebar-deck-sources-wizard"
                disabled={cookingAll || briefRunning}
                onClick={() => setBriefOpen(true)}
              >
                Brief / templates
              </button>
              <button
                type="button"
                className="sidebar-theme-snippet sidebar-theme-snippet--with-brief"
                onClick={() => setDeckScaffoldMinimized(false)}
                title="Show templates and theme presets"
              >
                <p className="sidebar-theme-snippet-label">Theme & templates</p>
                <div className="sidebar-theme-snippet-row">
                  <span className="theme-swatch" aria-hidden>
                    <span style={{ background: theme.cssVars.paper }} />
                    <span style={{ background: theme.cssVars.ink }} />
                    <span style={{ background: theme.cssVars.accent }} />
                  </span>
                  <span className="sidebar-theme-snippet-name">{theme.name}</span>
                  <span className="sidebar-theme-snippet-chevron" aria-hidden>
                    ▸
                  </span>
                </div>
              </button>
            </div>
          : <section
              className="sidebar-deck-sources sidebar-deck-sources--expanded"
              aria-label="Deck starters and themes"
            >
              <p className="sidebar-deck-sources-heading">Deck starters</p>
              <p className="sidebar-deck-sources-sub">
                Outline from a written brief or drop in a reusable slide arc.
              </p>
              <button
                className="loud-button sidebar-deck-sources-brief"
                type="button"
                disabled={cookingAll || briefRunning}
                onClick={() => setBriefOpen(true)}
              >
                From brief ✨
              </button>
              <p className="sidebar-deck-templates-heading">Templates</p>
              <div className="sidebar-template-quick" role="group" aria-label="Starter templates">
                {TEMPLATE_LIST.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="sidebar-template-chip"
                    disabled={cookingAll || briefRunning || lockingStyle}
                    onClick={() => applyTemplate(t)}
                    title={t.blurb}
                  >
                    <span className="sidebar-template-chip-name">{t.name}</span>
                    <span className="sidebar-template-chip-scope">{t.scope}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="ghost-button sidebar-deck-sources-tuck"
                onClick={() => setDeckScaffoldMinimized(true)}
              >
                Minimize theme & starters
              </button>
            </section>
          }

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

        {deckScaffoldMinimized ?
          <div className="sidebar-setup-minimized-tail">
            {theme.id === "locked" && (
              <div className="theme-locked-row theme-locked-row-compact">
                <span className="theme-locked-label" title={theme.blurb}>
                  ⚲ {theme.name}
                </span>
                <button className="theme-unlock" type="button" onClick={() => setTheme(DEFAULT_THEME)}>
                  unlock
                </button>
              </div>
            )}
            <button
              className="ghost-button theme-lock-button sidebar-setup-minimized-btn"
              type="button"
              disabled={!slideDisplayImage(selectedSlide) || lockingStyle}
              onClick={() => {
                void lockStyleFromSelectedSlide();
              }}
              title={
                selectedSlide && slideDisplayImage(selectedSlide)
                  ? "Use this slide's palette + style for the rest of the deck"
                  : "Cook an image slide first, then lock its style"
              }
            >
              {lockingStyle ? "reading..." : "Lock style from slide"}
            </button>
            <div className="sidebar-reset-footer">
              <button
                type="button"
                className="ghost-button sidebar-reset-trigger"
                onClick={() => resetFrontend()}
                disabled={cookingAll || briefRunning || lockingStyle || exporting}
                title="Clear local snapshot, undo/redo stack, overlays, URL hash — back to two starter slides."
              >
                Reset app…
              </button>
            </div>
          </div>
        : <div className="theme-card">
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
            disabled={!slideDisplayImage(selectedSlide) || lockingStyle}
            onClick={() => {
              void lockStyleFromSelectedSlide();
            }}
            title={
              selectedSlide && slideDisplayImage(selectedSlide)
                ? "Use this slide's palette + style for the rest of the deck"
                : "Cook an image slide first, then lock its style"
            }
          >
            {lockingStyle ? "reading..." : "Lock style from this slide"}
          </button>
          <div className="sidebar-reset-footer">
            <button
              type="button"
              className="ghost-button sidebar-reset-trigger"
              onClick={() => resetFrontend()}
              disabled={cookingAll || briefRunning || lockingStyle || exporting}
              title="Clear local snapshot, undo/redo stack, overlays, URL hash — back to two starter slides."
            >
              Reset app…
            </button>
          </div>
        </div>}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={slides.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="slide-list">
              {slides.map((slide, index) => (
                <SortableThumb
                  key={slide.id}
                  slide={slide}
                  index={index}
                  isActive={slide.id === selectedSlide?.id}
                  onClick={() => setSelectedId(slide.id)}
                  onDelete={() => killSlide(slide.id)}
                  deleteDisabled={slides.length <= 1}
                  deleteTitle={slides.length <= 1 ? "One slide is required" : "Delete this slide"}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </aside>

      <section className="editor">
        <header className="editor-topbar">
          <div className="editor-topbar-inner">
            <p className="editor-topbar-title">Studio</p>
            <nav className="top-actions editor-top-actions" aria-label="Deck actions">
              <button
                className="ghost-button icon-button"
                onClick={doUndo}
                disabled={!historyRef.current.canUndo()}
                type="button"
                title="Undo (⌘Z)"
                aria-label="Undo"
              >
                ↶
              </button>
              <button
                className="ghost-button icon-button"
                onClick={doRedo}
                disabled={!historyRef.current.canRedo()}
                type="button"
                title="Redo (⌘⇧Z)"
                aria-label="Redo"
              >
                ↷
              </button>
              <span className="editor-toolbar-divider" aria-hidden />
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
                onClick={() => {
                  void copyShareLink();
                }}
                type="button"
                title="Compressed link with outlines and theme — image bytes stay local"
              >
                Share link
              </button>
              <button
                className="ghost-button"
                disabled={exporting}
                onClick={exportDeck}
                type="button"
              >
                {exporting ? "packing..." : "PPT-ish"}
              </button>
            </nav>
          </div>
        </header>

        <div className="editor-rail">
        {(() => {
          const isWorking = selectedSlide?.status === "working";
          const elapsed = elapsedSeconds(selectedSlide?.startedAt, Date.now());
          const displayImg = slideDisplayImage(selectedSlide);
          const hasRendered = slideHasRenderedContent(selectedSlide);
          const primaryDisabled =
            cookingAll ||
            lockingStyle ||
            briefRunning ||
            isWorking ||
            (!hasRendered && !(selectedSlide?.prompt ?? "").trim());
          return (
            <div className="editor-canvas-with-ai">
              <div className={`editor-canvas-column ${isWorking ? "is-working" : ""}`}>
                <div className={`canvas-wrap ${isWorking ? "is-working" : ""}`}>
                  <div className="canvas-card-wrap">
                    <div className={`canvas-card ${isWorking ? "is-working" : ""}`}>
                      {selectedSlide?.kind === "layout" && selectedSlide.layout ?
                        <LayoutSlide layout={selectedSlide.layout} />
                      : displayImg ?
                        <img
                          alt={selectedSlide.name}
                          className="slide-image"
                          src={displayImg}
                        />
                      : <div className="empty-state">
                          <p>No slide yet.</p>
                          <span>Use the panel on the right — add a brief and generate.</span>
                        </div>
                      }
                      {isWorking && (
                        <div className="canvas-progress" aria-hidden>
                          <div className="canvas-shimmer" />
                        </div>
                      )}
                    </div>

                    <div className="feedback-bar" aria-live="polite">
                      <span className="feedback-bar-status">
                        {selectedSlide?.status ?? "idle"}
                        {isWorking && (
                          <span className="feedback-bar-elapsed"> · {elapsed}s</span>
                        )}
                      </span>
                      <span className="feedback-bar-msg">
                        {isWorking ?
                          workingHint({
                            suggestedFormat: selectedSlide?.suggestedFormat,
                            elapsed
                          })
                        : selectedSlide?.feedback?.trim() ?
                          selectedSlide.feedback
                        : selectedSlide?.status === "done" ?
                          ""
                        : "Ready when you are."}
                      </span>
                    </div>
                  </div>
                </div>

                {selectedSlide &&
                  selectedSlide.imageVariants &&
                  selectedSlide.imageVariants.length > 1 &&
                  selectedSlide.status !== "working" && (
                    <div className="variant-strip" role="group" aria-label="Image variants">
                      {selectedSlide.imageVariants.map((v, i) => (
                        <button
                          key={i}
                          type="button"
                          className={`variant-thumb ${(selectedSlide.imageVariantPick ?? 0) === i ? "active" : ""}`}
                          onClick={() =>
                          patchSlide(selectedSlide.id, {
                            imageVariantPick: i,
                            imageData: v.imageData
                          })
                          }
                        >
                          <span className="variant-thumb-label">{String.fromCharCode(65 + i)}</span>
                          <img alt="" src={v.imageData} draggable={false} />
                        </button>
                      ))}
                      <button
                        type="button"
                        className="ghost-button variant-dismiss"
                        onClick={() =>
                          patchSlide(selectedSlide.id, {
                            imageVariants: undefined,
                            imageVariantPick: undefined
                          })
                        }
                      >
                        collapse
                      </button>
                    </div>
                  )}

                {selectedSlide && (
                  <div className="editor-notes-block">
                    <label className="field-label field-label-soft" htmlFor="note-box">
                      Speaker notes
                    </label>
                    <textarea
                      id="note-box"
                      onChange={(event) =>
                        patchSlide(selectedSlide.id, { note: event.target.value })
                      }
                      placeholder="Cue cards, pacing, stats to mention aloud…"
                      rows={4}
                      value={selectedSlide.note ?? ""}
                    />
                  </div>
                )}
              </div>

              {selectedSlide && (
                <aside className="slide-ai-sidebar" aria-label="Slide brief, format, and AI">
                  <p className="eyebrow">Slide & AI</p>
                  <p className="slide-ai-hint">
                    {!hasRendered ?
                      "Describe what this slide should communicate, pick format, then generate."
                    : "Refine with instructions, refresh without changing the brief below the hood, or use 3 looks on image slides."}
                  </p>

                  {!hasRendered && (
                    <div className="slide-ai-brief-block">
                      <label className="field-label field-label-soft" htmlFor={`slide-brief-${selectedSlide.id}`}>
                        Slide brief
                      </label>
                      <textarea
                        id={`slide-brief-${selectedSlide.id}`}
                        onChange={(event) =>
                          patchSlide(selectedSlide.id, { prompt: event.target.value })
                        }
                        placeholder="What this slide must convey — layout vs image follows your format chips (or auto)."
                        rows={5}
                        disabled={isWorking || cookingAll || lockingStyle || briefRunning}
                        value={selectedSlide.prompt ?? ""}
                      />
                    </div>
                  )}

                  <label className="field-label field-label-soft" htmlFor={`format-${selectedSlide.id}`}>
                    Format override
                  </label>
                  <div className="format-chips" id={`format-${selectedSlide.id}`} role="group">
                    {FORMAT_OPTIONS.map((option) => {
                      const currentFormat = selectedSlide.suggestedFormat ?? "auto";
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`format-chip ${currentFormat === option.value ? "active" : ""}`}
                          onClick={() =>
                            patchSlide(selectedSlide.id, { suggestedFormat: option.value })
                          }
                          disabled={selectedSlide.status === "working"}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>

                  <label className="field-label field-label-soft" htmlFor={`slide-ai-${selectedSlide.id}`}>
                    AI instructions {!hasRendered && "(optional)"}
                  </label>
                  <textarea
                    id={`slide-ai-${selectedSlide.id}`}
                    key={selectedSlide.id}
                    className="slide-ai-instructions"
                    defaultValue={slideEditDraftRef.current[selectedSlide.id] ?? ""}
                    onChange={(e) => {
                      slideEditDraftRef.current[selectedSlide.id] = e.target.value;
                    }}
                    placeholder={
                      hasRendered ?
                        `e.g. "Change bullet 4 to …" — or leave blank to refresh from the saved brief`
                      : `Optional: steer the first version (e.g. "lead with the stat")`
                    }
                    rows={hasRendered ? 7 : 4}
                    disabled={isWorking || cookingAll || lockingStyle || briefRunning}
                  />

                  <div className="slide-ai-actions-row">
                    {isWorking && !cookingAll ?
                      <button
                        className="ghost-button stop-button slide-ai-primary"
                        onClick={() => stopSelectedSlideGeneration()}
                        type="button"
                      >
                        Stop
                      </button>
                    : <button
                        type="button"
                        className="loud-button slide-ai-primary"
                        disabled={primaryDisabled}
                        onClick={() => {
                          void applySlidePanelAction();
                        }}
                      >
                        {!hasRendered ? "Generate slide" : "Update slide"}
                      </button>
                    }
                  </div>

                  <div className="slide-ai-extra-actions">
                    <button
                      className="ghost-button slide-ai-wide"
                      disabled={
                        selectedSlide.status === "working" ||
                        !(
                          selectedSlide.suggestedFormat === "image" ||
                          selectedSlide.kind === "image"
                        )
                      }
                      onClick={() => {
                        void exploreImageVariants();
                      }}
                      title="Runs three parallel image generations (different compositions)"
                      type="button"
                    >
                      3 looks
                    </button>
                    <button
                      className="ghost-button slide-ai-wide"
                      disabled={
                        selectedSlide.status !== "done" ||
                        selectedSlide.critiquing ||
                        (!slideDisplayImage(selectedSlide) && !selectedSlide.layout)
                      }
                      onClick={() => {
                        if (selectedSlide.critique) {
                          setCritiquePanelOpen(true);
                        } else {
                          void critiqueSelectedSlide();
                        }
                      }}
                      title="Get specific, blunt feedback from a presentation coach"
                      type="button"
                    >
                      {selectedSlide.critiquing
                        ? "thinking..."
                        : selectedSlide.critique
                          ? "View critique"
                          : "Critique"}
                    </button>
                  </div>
                </aside>
              )}
            </div>
          );
        })()}

        </div>

        {message.trim() ?
          <footer className="editor-foot">
            <div className="editor-foot-inner">
              <div className="status-bar">{message}</div>
            </div>
          </footer>
        : null}
      </section>

      {presenterOpen && slides[presenterIndex] && (() => {
        const slide = slides[presenterIndex];
        const presenterImg = slideDisplayImage(slide);
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
              ) : presenterImg ? (
                <img alt={slide.name} className="presenter-image" src={presenterImg} />
              ) : (
                <div className="presenter-empty">
                  <p>{slide.name}</p>
                  <span>Use the panel on the right to generate this slide.</span>
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

            <div className="brief-label-row">
              <label className="field-label brief-label-inline" htmlFor="brief-textarea">
                The brief
              </label>
              {isVoiceSupported() && (
                <button
                  type="button"
                  className={`ghost-button voice-mic-button ${voiceBriefListening ? "active" : ""}`}
                  onClick={() => toggleVoiceBrief()}
                  disabled={briefRunning}
                  aria-pressed={voiceBriefListening}
                >
                  {voiceBriefListening ? "Listening…" : "Dictate"}
                </button>
              )}
            </div>
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

            <div className="template-divider">
              <span>or pick a template</span>
            </div>

            <div className="template-grid" role="group" aria-label="Deck templates">
              {TEMPLATE_LIST.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="template-card"
                  onClick={() => applyTemplate(t)}
                  disabled={briefRunning}
                >
                  <div className="template-card-head">
                    <span className="template-card-name">{t.name}</span>
                    <span className="template-card-scope">{t.scope}</span>
                  </div>
                  <p className="template-card-blurb">{t.blurb}</p>
                </button>
              ))}
            </div>
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
