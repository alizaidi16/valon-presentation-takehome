"use client";

import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import {
  coercePersistedTheme,
  DEFAULT_THEME,
  DEFAULT_THEME_TYPOGRAPHY,
  patchThemeColors,
  patchThemeTypography,
  THEME_PICKER_PRESETS,
  PRESET_THEMES,
  sanitizeHex,
  type Theme,
  type ThemeFontStack,
  withDefaultTypography
} from "@/lib/ai/themes";
import { elapsedSeconds } from "@/lib/ui/working-feedback";
import { EditableLayoutSlide } from "@/lib/ui/editable-layout-slide";
import { slideThumbnailHeading } from "@/lib/ui/slide-thumbnail-heading";
import { HistoryStack } from "@/lib/history/stack";
import { normalizeFormat } from "@/lib/ai/helpers";
import { decodeDeckHash, encodeDeckHash, toSharePayload } from "@/lib/share/deck-url";
import { isVoiceSupported, startVoiceRecognition, type VoiceController } from "@/lib/voice/recognition";

type SlideStatus = "idle" | "working" | "done" | "error";
type FormatOverride = "auto" | "image" | "title" | "bullets" | "grid" | "stats";

/** Sidebar theme row: `null` when the deck uses a locked-from-slide theme (no preset chip). */
type ThemeSidebarLane = "default" | "monochrome" | null;

const FORMAT_OPTIONS: Array<{ value: FormatOverride; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "image", label: "image" },
  { value: "title", label: "title" },
  { value: "bullets", label: "bullets" },
  { value: "grid", label: "grid" },
  { value: "stats", label: "stats" }
];

function relSlideLuminance(hex: string): number {
  const s = sanitizeHex(hex);
  if (!s) return 0.5;
  const r = parseInt(s.slice(1, 3), 16) / 255;
  const g = parseInt(s.slice(3, 5), 16) / 255;
  const b = parseInt(s.slice(5, 7), 16) / 255;
  const lin = [r, g, b].map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Recessed panels on layout slides (stats / grid tiles). Must be scoped with the
 * deck theme — otherwise grid + stat cards keep :root --card-tint and look
 * unchanged when switching themes (especially pitch vs light presets).
 */
function deriveSlideCardTint(css: Theme["cssVars"]): string {
  const paperSan = sanitizeHex(css.paper) ?? css.paper.trim();
  const bgSan = sanitizeHex(css.bg) ?? css.bg.trim();
  const paper = paperSan.toLowerCase();
  const bg = bgSan.toLowerCase();

  if (paper === "#101a2c") {
    return "#181f31";
  }
  /** Imported sites often coerce paper/bg to identical white → cards must still read as tiles. */
  if (sanitizeHex(css.paper) === sanitizeHex(css.bg) && relSlideLuminance(paperSan) > 0.9) {
    return `color-mix(in srgb, ${paperSan} 92%, ${css.ink} 8%)`;
  }
  if (paper === "#ffffff" || paper === "#fff") {
    return bgSan;
  }
  return bgSan;
}

function slideFontStackVar(stack: ThemeFontStack): string {
  if (stack === "sans") return "var(--font-sans)";
  if (stack === "mono") return "var(--font-mono)";
  return "var(--font-display)";
}

function activeThemeLane(theme: Theme): "default" | "monochrome" {
  if (theme.id === "monochrome" || theme.source === "monochrome") return "monochrome";
  return "default";
}

function themeSidebarLaneFromTheme(t: Theme): ThemeSidebarLane {
  if (t.id === "locked") return null;
  return activeThemeLane(t);
}

/** Shallow-stable preset apply — avoids `setTheme` no-ops when the canonical preset object equals current state (React compares by identity). */
function deckPresetClone(id: "default" | "monochrome"): Theme {
  const p = PRESET_THEMES[id];
  return withDefaultTypography({
    ...p,
    cssVars: { ...p.cssVars },
    pptx: { ...p.pptx },
    typography: { ...(p.typography ?? DEFAULT_THEME_TYPOGRAPHY) }
  });
}

/** Deck palette + slide typography — app chrome keeps :root tokens. */
function deckThemeScopedStyle(theme: Theme): CSSProperties {
  const css = theme.cssVars;
  const typo = theme.typography ?? DEFAULT_THEME_TYPOGRAPHY;
  const cardTint = deriveSlideCardTint(css);
  return {
    "--bg": css.bg,
    "--paper": css.paper,
    "--ink": css.ink,
    "--ink-soft": css.inkSoft,
    "--ink-muted": css.inkMuted,
    "--rule": css.rule,
    "--rule-strong": css.ruleStrong,
    "--accent": css.accent,
    "--accent-soft": css.accentSoft,
    "--gold": css.accent,
    "--gold-soft": css.accentSoft,
    "--card-tint": cardTint,
    "--font-slide-display": slideFontStackVar(typo.displayFont),
    "--font-slide-body": slideFontStackVar(typo.bodyFont),
    "--slide-type-scale": String(typo.slideScale)
  } as CSSProperties;
}

function toColorInputValue(c: string): string {
  const h = sanitizeHex(c);
  return h ?? "#888888";
}

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
  /** Legacy persisted field from older decks; still honored when resolving `slideDisplayImage`. */
  imageVariants?: Array<{ imageData: string; reasoning?: string }>;
  /** Legacy persisted field; paired with `imageVariants`. */
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

/** True when the slide already has layout or image pixels — saved prompt stays in data but isn't shown separately. */
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

type BriefWizardStep = "compose" | "review";

/** Editable outline row in the brief review step (checkbox + stable React key). */
type BriefPlanRow = OutlineSlide & { rowId: string; included: boolean };

const STORAGE_KEY = "valon-presentation-takehome-upstream-reference-v6";

/** Shown in the nav until renamed, after reset, or if the outline has no AI title yet. */
const DEFAULT_WORKSPACE_TITLE = "Untitled";

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

/** Fixed so SSR and the client's first paint match (crypto UUIDs differ per process). */
const STARTER_SLIDE_IDS = ["slide-starter-1", "slide-starter-2"] as const;

function makeSlide(index: number, stableId?: string): Slide {
  return {
    id: stableId ?? crypto.randomUUID(),
    name: `Slide ${index + 1}`,
    prompt: index === 0 ? DEFAULT_STARTER_SLIDE_PROMPT : "",
    status: "idle",
    note: ""
  };
}

function starterSlides(): Slide[] {
  return [makeSlide(0, STARTER_SLIDE_IDS[0]), makeSlide(1, STARTER_SLIDE_IDS[1])];
}

/** True only for the untouched two-slide starter scaffold (names/prompts/status, not ids). */
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
    const hl = (layout.headline ?? "").trim();
    return (
      <div className="layout-slide layout-stats">
        {hl ? <p className="ls-section-headline">{hl}</p> : null}
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

function AppLogoMark() {
  const gid = useId().replace(/:/g, "");
  return (
    <svg
      className="app-logo-svg"
      width="34"
      height="34"
      viewBox="0 0 34 34"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={`app-logo-grad-${gid}`} x1="6" y1="6" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-hover)" />
        </linearGradient>
      </defs>
      <rect x="5" y="10" width="19" height="14" rx="3" fill="var(--surface-3)" stroke="var(--rule)" strokeWidth="1" />
      <rect x="9" y="14" width="19" height="14" rx="3" fill="var(--paper)" stroke="var(--rule-strong)" strokeWidth="1" />
      <circle cx="13.5" cy="16.5" r="3.4" fill={`url(#app-logo-grad-${gid})`} />
    </svg>
  );
}

/**
 * Non-sortable thumbnail — SSR + initial client paint only. Mirrors SortableThumb
 * DOM so hydration matches; @dnd-kit's useUniqueId counter diverges server vs browser.
 */
function StaticSlideThumb({
  slide,
  index,
  isActive,
  onClick,
  onDelete,
  onInsertBelow,
  deleteDisabled,
  deleteTitle,
  deckSlideTheme
}: {
  slide: Slide;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onInsertBelow: () => void;
  deleteDisabled: boolean;
  deleteTitle: string;
  deckSlideTheme: Theme;
}) {
  const isWorking = slide.status === "working";
  const elapsed = elapsedSeconds(slide.startedAt, Date.now());
  const thumbSrc = slideDisplayImage(slide);
  const thumbHeading = slideThumbnailHeading(slide, { listIndex: index });

  return (
    <div className={`thumb-shell ${isActive ? "active" : ""}`}>
      <button
        type="button"
        className="thumb-delete thumb-corner-action"
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
        type="button"
        className="thumb-add-below thumb-corner-action"
        aria-label={`Add slide below slide ${index + 1}: ${thumbHeading}`}
        title="Add slide below this one"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onInsertBelow();
        }}
      >
        +
      </button>
      <button
        className={`thumb ${isWorking ? "is-working" : ""} status-${slide.status}`}
        onClick={onClick}
        type="button"
      >
        <div
          className="thumb-art"
          style={slide.layout ? deckThemeScopedStyle(deckSlideTheme) : undefined}
        >
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
  onInsertBelow,
  deleteDisabled,
  deleteTitle,
  deckSlideTheme
}: {
  slide: Slide;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onInsertBelow: () => void;
  deleteDisabled: boolean;
  deleteTitle: string;
  deckSlideTheme: Theme;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id
  });
  const isWorking = slide.status === "working";
  const elapsed = elapsedSeconds(slide.startedAt, Date.now());
  const thumbSrc = slideDisplayImage(slide);
  const thumbHeading = slideThumbnailHeading(slide, { listIndex: index });

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
        className="thumb-delete thumb-corner-action"
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
        type="button"
        className="thumb-add-below thumb-corner-action"
        aria-label={`Add slide below slide ${index + 1}: ${thumbHeading}`}
        title="Add slide below this one"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onInsertBelow();
        }}
      >
        +
      </button>
      <button
        className={`thumb ${isWorking ? "is-working" : ""} status-${slide.status}`}
        onClick={onClick}
        type="button"
        {...attributes}
        {...listeners}
      >
        <div
          className="thumb-art"
          style={slide.layout ? deckThemeScopedStyle(deckSlideTheme) : undefined}
        >
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
  const [shareExportMenuOpen, setShareExportMenuOpen] = useState(false);
  const shareExportMenuRef = useRef<HTMLDivElement>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefText, setBriefText] = useState("");
  const [briefSlideCount, setBriefSlideCount] = useState<number | "">(7);
  const [briefRunning, setBriefRunning] = useState(false);
  const [briefWizardStep, setBriefWizardStep] = useState<BriefWizardStep>("compose");
  /** Populated after the API returns an outline — user edits before creating slides. */
  const [briefPlanTitle, setBriefPlanTitle] = useState("");
  const [briefPlanRows, setBriefPlanRows] = useState<BriefPlanRow[] | null>(null);
  /**
   * Sidebar panels tuck independently — brief/outline entry vs theme picker —
   * so collapsing one doesn't hide the other.
   */
  const [briefSectionExpanded, setBriefSectionExpanded] = useState(true);
  const [themeSectionExpanded, setThemeSectionExpanded] = useState(true);

  const [cookingAll, setCookingAll] = useState(false);
  const cookAbortRef = useRef<AbortController | null>(null);
  /** AbortController for single-slide Cook / Again (not shared with Retry-failed batch). */
  const soloCookAbortRef = useRef<AbortController | null>(null);
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
  /** Active deck theme (preset, custom, imported site palette, etc.). Persisted to localStorage. */
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  /** Set when the user picks a preset/lane/edits/import — hydrate must not overwrite with localStorage if this ran first (effect runs after first paint). */
  const deckThemeUserTouchedRef = useRef(false);
  const [themeSidebarLane, setThemeSidebarLane] = useState<ThemeSidebarLane>("default");
  /** dnd-kit assigns unstable ids SSR vs browser — defer sortable rail until mounted. */
  const [slideDndReady, setSlideDndReady] = useState(false);
  /** Visible workspace title in the nav (editable). */
  const [deckName, setDeckName] = useState(DEFAULT_WORKSPACE_TITLE);
  const [deckNameEditing, setDeckNameEditing] = useState(false);
  const [deckNameDraft, setDeckNameDraft] = useState("");
  const deckNameInputRef = useRef<HTMLInputElement | null>(null);
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
   * add/kill/reorder/brief/style-lock. Inline text edits (name,
   * notes, prompt) are excluded — those would explode the history with
   * per-keystroke entries, and the textarea's native Cmd+Z covers them.
   * `historyVersion` bumps after every history op so the Undo/Redo
   * button disabled state re-evaluates on each render.
   */
  const historyRef = useRef(new HistoryStack<DeckSnapshot>(50));
  const [, bumpHistory] = useState(0);

  /** Bumped when the deck is wiped (reset); blocks stale brief completions. */
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
    setSlideDndReady(true);
  }, []);

  useEffect(() => {
    if (deckNameEditing) {
      deckNameInputRef.current?.focus();
      deckNameInputRef.current?.select();
    }
  }, [deckNameEditing]);

  useEffect(() => {
    const t = deckName.trim();
    document.title = t ? `${t} — Deck studio` : "Deck studio";
  }, [deckName]);

  useEffect(() => {
    if (!briefOpen) {
      voiceBriefBaselineRef.current = "";
      stopVoiceBrief();
      setBriefWizardStep("compose");
      setBriefPlanRows(null);
      setBriefPlanTitle("");
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
            const sharedTheme = coercePersistedTheme(decoded.theme);
            setTheme(sharedTheme);
            setThemeSidebarLane(themeSidebarLaneFromTheme(sharedTheme));
            setBriefSectionExpanded(false);
            setThemeSectionExpanded(false);
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
          setBriefSectionExpanded(true);
          setThemeSectionExpanded(true);
          return;
        }

        try {
          const parsed = JSON.parse(saved) as {
            slides: Slide[];
            selectedId: string;
            theme?: Theme;
            deckScaffoldMinimized?: boolean;
            briefSectionExpanded?: boolean;
            themeSectionExpanded?: boolean;
            deckName?: string;
          };

          if (parsed.slides?.length) {
            const normalized = normalizeSlidesAfterLoad(parsed.slides);
            setSlides(normalized);
            setSelectedId(parsed.selectedId || parsed.slides[0].id);
            if (typeof parsed.deckName === "string" && parsed.deckName.trim()) {
              setDeckName(parsed.deckName.trim());
            }
            const minimizedLegacy =
              typeof parsed.deckScaffoldMinimized === "boolean" ?
                parsed.deckScaffoldMinimized
              : !isPristineStarterDeck(normalized);
            const defaultExpanded = !minimizedLegacy;
            setBriefSectionExpanded(
              typeof parsed.briefSectionExpanded === "boolean" ?
                parsed.briefSectionExpanded
              : defaultExpanded
            );
            setThemeSectionExpanded(
              typeof parsed.themeSectionExpanded === "boolean" ?
                parsed.themeSectionExpanded
              : defaultExpanded
            );
          }
          if (
            parsed.theme &&
            parsed.theme.cssVars &&
            parsed.theme.pptx &&
            !deckThemeUserTouchedRef.current
          ) {
            const loaded = coercePersistedTheme(parsed.theme);
            setTheme(loaded);
            setThemeSidebarLane(themeSidebarLaneFromTheme(loaded));
          }
        } catch {
          const fresh = starterSlides();
          setSlides(fresh);
          setSelectedId(fresh[0]?.id ?? "");
          setBriefSectionExpanded(true);
          setThemeSectionExpanded(true);
        }
      } catch {
        if (!cancelled) {
          const fresh = starterSlides();
          setSlides(fresh);
          setSelectedId(fresh[0]?.id ?? "");
          setBriefSectionExpanded(true);
          setThemeSectionExpanded(true);
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
        briefSectionExpanded,
        themeSectionExpanded,
        deckName
      });
      const liteJson = JSON.stringify({
        slides: slidesForLimitedStorage(slides),
        selectedId: sel,
        theme,
        lite: true,
        briefSectionExpanded,
        themeSectionExpanded,
        deckName
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
  }, [slides, selectedId, theme, hydrationDone, briefSectionExpanded, themeSectionExpanded, deckName]);

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

      // Holding ⌘Z / Ctrl+Z fires key repeat — each event would pop another snapshot
      // and feels like "undo wiped everything". One undo per key press only.
      if (event.repeat) return;

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

  useEffect(() => {
    if (!shareExportMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!shareExportMenuRef.current?.contains(e.target as Node)) {
        setShareExportMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShareExportMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareExportMenuOpen]);

  function patchSlide(id: string, patch: Partial<Slide>) {
    setSlides((current) =>
      current.map((slide) => (slide.id === id ? { ...slide, ...patch } : slide))
    );
  }

  function insertSlideBelow(afterIndex: number) {
    snapshotForUndo();
    const next = makeSlide(slides.length);
    setSlides((current) => {
      const copy = [...current];
      copy.splice(afterIndex + 1, 0, next);
      return copy;
    });
    setSelectedId(next.id);
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
   * any structural mutation (add/kill/reorder/brief). */
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
   * Cook one slide. Patches the slide's status as it progresses. Used by the
   * single-slide Cook controls and the sidebar "Retry failed" batch.
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
          feedback: "Cook this slide first, or add instructions before asking for AI edits."
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
      setMessage("Add instructions for the AI first.");
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

  /**
   * Tiered batch: layout slides go in parallel (cheap, fast), image/auto slides
   * are throttled to 3 concurrent (rate-limit friendly). Layout slides typically
   * resolve within seconds, giving the user fast visible progress.
   */
  async function cookAllSlides(opts: { onlyFailed?: boolean; slides?: Slide[] } = {}) {
    const deck = opts.onlyFailed ? slides : opts.slides ?? slides;
    const targets = deck.filter((s) => {
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
   * Aborts the in-flight batch (Retry failed / multi-slide cook) and shuts overlays so stale async work cannot patch the cleared deck.
   */
  function resetFrontend() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Reset to the starter deck? This clears all slides (including undo history), the saved browser backup, overlays, and any #share= link in the URL."
      )
    ) {
      return;
    }

    cookAbortRef.current?.abort();
    cookAbortRef.current = null;
    soloCookAbortRef.current?.abort();
    soloCookAbortRef.current = null;
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
    deckThemeUserTouchedRef.current = false;
    setTheme(DEFAULT_THEME);
    setThemeSidebarLane("default");
    historyRef.current.reset();
    bumpHistory((n) => n + 1);

    setBriefOpen(false);
    setBriefText("");
    setBriefSlideCount(7);
    setBriefSectionExpanded(true);
    setThemeSectionExpanded(true);
    setPresenterOpen(false);
    setPresenterShowNotes(false);
    setPresenterIndex(0);
    setCritiquePanelOpen(false);
    setExporting(false);
    setCookingAll(false);
    setDeckName(DEFAULT_WORKSPACE_TITLE);
    setDeckNameEditing(false);
    setDeckNameDraft("");

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
      anchor.download = "valon-presentation-takehome-upstream-reference-export.pptx";
      anchor.click();
      window.URL.revokeObjectURL(url);
      setMessage("Download started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function draftOutlineFromBrief() {
    if (!briefText.trim()) {
      setMessage("Need a brief to work from.");
      return;
    }

    const epoch = deckEpochRef.current;
    setBriefRunning(true);
    setMessage("Drafting slide-by-slide outline...");

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

      if (!response.ok || payload.error || !payload.slides?.length || !payload.deckTitle) {
        setMessage(payload.error ?? "Outline failed.");
        return;
      }

      if (deckEpochRef.current !== epoch) {
        setMessage("Outline arrived after a reset — ignored.");
        return;
      }

      const rows: BriefPlanRow[] = payload.slides.map((s) => ({
        rowId: crypto.randomUUID(),
        included: true,
        name: typeof s.name === "string" ? s.name : "",
        prompt: typeof s.prompt === "string" ? s.prompt : "",
        notes: typeof (s as { notes?: unknown }).notes === "string" ? (s as { notes: string }).notes : "",
        suggestedFormat: normalizeFormat((s as { suggestedFormat?: unknown }).suggestedFormat)
      }));

      setBriefPlanTitle(payload.deckTitle.trim());
      setBriefPlanRows(rows);
      setBriefWizardStep("review");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Outline failed.");
    } finally {
      setBriefRunning(false);
    }
  }

  function setBriefPlanAllIncluded(include: boolean) {
    setBriefPlanRows((prev) => prev?.map((row) => ({ ...row, included: include })) ?? null);
  }

  function updateBriefPlanRow(rowId: string, patch: Partial<Omit<BriefPlanRow, "rowId">>) {
    setBriefPlanRows((prev) =>
      prev?.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)) ?? null
    );
  }

  function confirmBriefPlanToDeck() {
    const rows = briefPlanRows ?? [];
    const picked = rows.filter((row) => row.included);
    if (picked.length === 0) {
      setMessage("Check at least one slide to create, or cancel.");
      return;
    }

    const epoch = deckEpochRef.current;

    const generatedSlides: Slide[] = picked.map((row) => ({
      id: crypto.randomUUID(),
      name: row.name.trim() || "Untitled slide",
      prompt: row.prompt,
      note: row.notes ?? "",
      suggestedFormat: row.suggestedFormat,
      status: "idle"
    }));

    if (deckEpochRef.current !== epoch) {
      return;
    }

    const titleForMsg = briefPlanTitle.trim() || "outline";

    snapshotForUndo();
    flushSync(() => {
      const generatedDeckTitle = briefPlanTitle.trim();
      setDeckName(generatedDeckTitle.length ? generatedDeckTitle : DEFAULT_WORKSPACE_TITLE);
      setSlides(generatedSlides);
      setSelectedId(generatedSlides[0]?.id ?? "");
      setBriefSectionExpanded(false);
      setThemeSectionExpanded(false);
      setBriefOpen(false);
      setBriefText("");
    });
    setMessage(`Created ${generatedSlides.length} slide(s) from “${titleForMsg}” — generating…`);
    void cookAllSlides({ slides: generatedSlides });
  }

  return (
    <main className="shell">
      <header className="app-nav" role="banner">
        <div className="app-nav-inner">
          <div className="app-nav-leading">
            <span className="app-logo-wrap" title="Deck studio">
              <AppLogoMark />
            </span>
            {deckNameEditing ?
              <input
                ref={deckNameInputRef}
                className="app-nav-deck-input"
                aria-label="Workspace name"
                value={deckNameDraft}
                onChange={(e) => setDeckNameDraft(e.target.value)}
                onBlur={() => {
                  const next = deckNameDraft.trim();
                  setDeckName(next.length ? next : DEFAULT_WORKSPACE_TITLE);
                  setDeckNameEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    deckNameInputRef.current?.blur();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDeckNameEditing(false);
                  }
                }}
                maxLength={80}
              />
            : <button
                type="button"
                className="app-nav-deck-button"
                aria-label={`Workspace: ${deckName}. Click to rename.`}
                onClick={() => {
                  setDeckNameDraft(deckName);
                  setDeckNameEditing(true);
                }}
              >
                {deckName}
              </button>
            }
          </div>
          <nav className="top-actions app-nav-actions" aria-label="Deck actions">
            <button
              type="button"
              className="ghost-button app-nav-reset-btn"
              onClick={() => resetFrontend()}
              disabled={cookingAll || briefRunning || exporting}
              title="Reset to starter deck — clears local snapshot, undo/redo stack, overlays, URL hash."
              aria-label="Reset app to starter deck"
            >
              <span className="app-nav-reset-icon" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </span>
            </button>
            <button
              className="ghost-button icon-button"
              onClick={doUndo}
              disabled={!historyRef.current.canUndo()}
              type="button"
              title="Undo (⌘Z)"
              aria-label="Undo"
            >
              ←
            </button>
            <button
              className="ghost-button icon-button"
              onClick={doRedo}
              disabled={!historyRef.current.canRedo()}
              type="button"
              title="Redo (⌘⇧Z)"
              aria-label="Redo"
            >
              →
            </button>
            <span className="app-toolbar-divider" aria-hidden />
            <button
              className="loud-button"
              onClick={openPresenter}
              disabled={!slides.length}
              type="button"
              title="Present (Esc to exit, arrows to navigate, N for notes)"
            >
              Present ▶
            </button>
            <div className="app-share-export-dropdown" ref={shareExportMenuRef}>
              <button
                type="button"
                className="ghost-button app-share-export-trigger"
                aria-expanded={shareExportMenuOpen}
                aria-haspopup="menu"
                aria-controls="share-export-menu"
                onClick={() => setShareExportMenuOpen((open) => !open)}
              >
                Share / export
                <span className="app-share-export-caret" aria-hidden>
                  ▾
                </span>
              </button>
              {shareExportMenuOpen ?
                <div
                  id="share-export-menu"
                  role="menu"
                  aria-label="Export and share"
                  className="app-share-export-panel"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="app-share-export-item"
                    disabled={exporting || !slides.length}
                    title="Download a .pptx of this deck"
                    onClick={() => {
                      setShareExportMenuOpen(false);
                      void exportDeck();
                    }}
                  >
                    {exporting ? "Downloading…" : "Download"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="app-share-export-item"
                    title="Compressed link with outlines and theme — image bytes stay local"
                    onClick={() => {
                      setShareExportMenuOpen(false);
                      void copyShareLink();
                    }}
                  >
                    Share link
                  </button>
                </div>
              : null}
            </div>
          </nav>
        </div>
      </header>

      <div className="shell-columns">
      <aside className="sidebar">
        {briefSectionExpanded ?
          <section
            className="sidebar-deck-sources sidebar-deck-sources--expanded"
            aria-label="Create a deck using brief"
          >
            <div className="sidebar-panel-head">
              <p className="sidebar-deck-sources-heading sidebar-brief-heading-plain">
                Create a deck using brief
              </p>
              <button
                type="button"
                className="sidebar-panel-icon-btn"
                aria-label="Collapse brief section"
                onClick={() => setBriefSectionExpanded(false)}
              >
                <span aria-hidden>▴</span>
              </button>
            </div>
            <p className="sidebar-deck-sources-sub">
              Draft a slide-by-slide outline from a written brief, then create the deck when you are ready.
            </p>
            <button
              className="loud-button sidebar-deck-sources-brief"
              type="button"
              disabled={cookingAll || briefRunning}
              onClick={() => setBriefOpen(true)}
            >
              From brief ✨
            </button>
          </section>
        : <div className="sidebar-brief-collapsed" aria-label="Brief (collapsed)">
            <div className="sidebar-panel-collapsed-row">
              <button
                type="button"
                className="loud-button sidebar-deck-sources-wizard"
                disabled={cookingAll || briefRunning}
                onClick={() => setBriefOpen(true)}
              >
                From brief
              </button>
              <button
                type="button"
                className="sidebar-panel-icon-btn"
                aria-label="Expand brief section"
                onClick={() => setBriefSectionExpanded(true)}
              >
                <span aria-hidden>▾</span>
              </button>
            </div>
          </div>
        }

        {themeSectionExpanded ?
          <div className="theme-card">
            <div className="sidebar-panel-head theme-card-panel-head">
              <p className="eyebrow">Theme</p>
              <button
                type="button"
                className="sidebar-panel-icon-btn"
                aria-label="Collapse theme section"
                onClick={() => setThemeSectionExpanded(false)}
              >
                <span aria-hidden>▴</span>
              </button>
            </div>
            <div className="theme-picker-stack">
              <div className="theme-chips" role="group" aria-label="Deck theme">
                {THEME_PICKER_PRESETS.map((t) => {
                  const laneKey = t.id === "monochrome" ? "monochrome" : "default";
                  const active = themeSidebarLane === laneKey;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="theme-chip"
                      aria-pressed={active}
                      onClick={() => {
                        deckThemeUserTouchedRef.current = true;
                        setThemeSidebarLane(laneKey);
                        setTheme(deckPresetClone(t.id as "default" | "monochrome"));
                      }}
                      title={t.blurb}
                    >
                      <span className="theme-swatch" aria-hidden>
                        <span style={{ background: t.cssVars.paper }} />
                        <span style={{ background: t.cssVars.ink }} />
                        <span style={{ background: t.cssVars.accent }} />
                      </span>
                      <span className="theme-chip-label">{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <details className="theme-customize">
              <summary>Customize theme · colors &amp; typography</summary>
              <div
                className="theme-customize-body"
                onPointerDownCapture={() => {
                  deckThemeUserTouchedRef.current = true;
                }}
              >
              <div className="theme-custom-grid">
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Paper (slide face)</span>
                  <input
                    type="color"
                    value={toColorInputValue(theme.cssVars.paper)}
                    onChange={(e) => setTheme(patchThemeColors(theme, { paper: e.target.value }))}
                  />
                </label>
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Ground (outside slide)</span>
                  <input
                    type="color"
                    value={toColorInputValue(theme.cssVars.bg)}
                    onChange={(e) => setTheme(patchThemeColors(theme, { bg: e.target.value }))}
                  />
                </label>
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Ink (text)</span>
                  <input
                    type="color"
                    value={toColorInputValue(theme.cssVars.ink)}
                    onChange={(e) => setTheme(patchThemeColors(theme, { ink: e.target.value }))}
                  />
                </label>
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Accent</span>
                  <input
                    type="color"
                    value={toColorInputValue(theme.cssVars.accent)}
                    onChange={(e) => setTheme(patchThemeColors(theme, { accent: e.target.value }))}
                  />
                </label>
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Display font (titles)</span>
                  <select
                    value={theme.typography?.displayFont ?? DEFAULT_THEME_TYPOGRAPHY.displayFont}
                    onChange={(e) =>
                      setTheme(patchThemeTypography(theme, { displayFont: e.target.value as ThemeFontStack }))
                    }
                  >
                    <option value="serif">Serif (Cormorant)</option>
                    <option value="sans">Sans (Albert Sans)</option>
                    <option value="mono">Mono (Geist)</option>
                  </select>
                </label>
                <label className="theme-custom-field">
                  <span className="theme-custom-field-label">Body font</span>
                  <select
                    value={theme.typography?.bodyFont ?? DEFAULT_THEME_TYPOGRAPHY.bodyFont}
                    onChange={(e) =>
                      setTheme(patchThemeTypography(theme, { bodyFont: e.target.value as ThemeFontStack }))
                    }
                  >
                    <option value="sans">Sans (Albert Sans)</option>
                    <option value="serif">Serif (Cormorant)</option>
                    <option value="mono">Mono (Geist)</option>
                  </select>
                </label>
                <label className="theme-custom-field theme-custom-field-span">
                  <span className="theme-custom-field-label">
                    Slide type scale · {(theme.typography?.slideScale ?? 1).toFixed(2)}×
                  </span>
                  <input
                    className="theme-slide-scale"
                    type="range"
                    min={0.85}
                    max={1.35}
                    step={0.02}
                    value={theme.typography?.slideScale ?? 1}
                    onChange={(e) =>
                      setTheme(patchThemeTypography(theme, { slideScale: Number(e.target.value) }))
                    }
                  />
                </label>
              </div>
              <button
                type="button"
                className="ghost-button theme-reset-preset-row"
                onClick={() => {
                  deckThemeUserTouchedRef.current = true;
                  setTheme(deckPresetClone("default"));
                  setThemeSidebarLane("default");
                }}
              >
                Reset to default preset
              </button>
              </div>
            </details>
          </div>
        : <div className="sidebar-theme-collapsed" aria-label="Theme (collapsed)">
            <div className="sidebar-panel-collapsed-row">
              <div className="sidebar-theme-collapsed-preview">
                <span className="theme-swatch" aria-hidden>
                  <span style={{ background: theme.cssVars.paper }} />
                  <span style={{ background: theme.cssVars.ink }} />
                  <span style={{ background: theme.cssVars.accent }} />
                </span>
                <span className="sidebar-theme-collapsed-name">{theme.name}</span>
              </div>
              <button
                type="button"
                className="sidebar-panel-icon-btn"
                aria-label="Expand theme section"
                onClick={() => setThemeSectionExpanded(true)}
              >
                <span aria-hidden>▾</span>
              </button>
            </div>
          </div>
        }

        {(cookingAll || slides.some((s) => s.status === "error")) && (
          <div className="sidebar-actions">
            {cookingAll ?
              <button
                className="ghost-button stop-button"
                onClick={cancelCookAll}
                type="button"
              >
                Stop ({slides.filter((s) => s.status === "working").length} running)
              </button>
            : <button
                type="button"
                className="ghost-button retry-button"
                onClick={() => {
                  void cookAllSlides({ onlyFailed: true });
                }}
              >
                Retry failed ({slides.filter((s) => s.status === "error").length})
              </button>
            }
          </div>
        )}

        {slideDndReady ?
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
                    onInsertBelow={() => insertSlideBelow(index)}
                    deleteDisabled={slides.length <= 1}
                    deleteTitle={slides.length <= 1 ? "One slide is required" : "Delete this slide"}
                    deckSlideTheme={theme}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        : <div className="slide-list">
            {slides.map((slide, index) => (
              <StaticSlideThumb
                key={slide.id}
                slide={slide}
                index={index}
                isActive={slide.id === selectedSlide?.id}
                onClick={() => setSelectedId(slide.id)}
                onDelete={() => killSlide(slide.id)}
                onInsertBelow={() => insertSlideBelow(index)}
                deleteDisabled={slides.length <= 1}
                deleteTitle={slides.length <= 1 ? "One slide is required" : "Delete this slide"}
                deckSlideTheme={theme}
              />
            ))}
          </div>
        }
      </aside>

      <section className="editor">
        <div className="editor-rail">
        {(() => {
          const isWorking = selectedSlide?.status === "working";
          const displayImg = slideDisplayImage(selectedSlide);
          const hasRendered = slideHasRenderedContent(selectedSlide);
          const primaryDisabled =
            cookingAll ||
            briefRunning ||
            isWorking ||
            (!hasRendered && !(selectedSlide?.prompt ?? "").trim());
          return (
            <div className="editor-canvas-with-ai">
              <div className={`editor-canvas-column ${isWorking ? "is-working" : ""}`}>
                <div className={`canvas-wrap ${isWorking ? "is-working" : ""}`}>
                  <div className="canvas-card-wrap">
                    <div
                      className={`canvas-card ${isWorking ? "is-working" : ""}`}
                      style={deckThemeScopedStyle(theme)}
                    >
                      {selectedSlide?.kind === "layout" && selectedSlide.layout ?
                        <EditableLayoutSlide
                          layout={selectedSlide.layout}
                          disabled={isWorking || cookingAll || briefRunning}
                          onCommit={(next) => {
                            const prev = selectedSlide.layout;
                            if (!prev || JSON.stringify(next) === JSON.stringify(prev)) return;
                            snapshotForUndo();
                            patchSlide(selectedSlide.id, { layout: next });
                          }}
                        />
                      : displayImg ?
                        <div className="canvas-image-editable-wrap">
                          <img
                            alt={selectedSlide.name}
                            className="slide-image"
                            src={displayImg}
                          />
                          <div className="canvas-slide-title-bar">
                            <input
                              type="text"
                              className="canvas-slide-title-input"
                              autoComplete="off"
                              aria-label="Slide title"
                              disabled={isWorking || cookingAll || briefRunning}
                              value={selectedSlide.name}
                              onChange={(e) =>
                                patchSlide(selectedSlide.id, { name: e.target.value })
                              }
                            />
                          </div>
                        </div>
                      : <div className="empty-state">
                          <p>No slide yet.</p>
                          <span>Use Instructions for AI on the right — then generate.</span>
                        </div>
                      }
                      {isWorking && (
                        <div className="canvas-progress" aria-hidden>
                          <div className="canvas-shimmer" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

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
                <aside
                  className="slide-ai-sidebar"
                  aria-label="Instructions for AI, format, and actions"
                >
                  <p className="eyebrow" id={`slide-ai-title-${selectedSlide.id}`}>
                    Instructions for AI
                  </p>
                  <p className="slide-ai-hint">
                    {!hasRendered ?
                      "Describe what this slide should communicate, pick format, then generate."
                    : "Add changes below for the next version, or leave it empty to regenerate from your original instructions (not shown here)."}
                  </p>

                  {!hasRendered ?
                    <textarea
                      id={`slide-ai-${selectedSlide.id}`}
                      className="slide-ai-instructions"
                      aria-labelledby={`slide-ai-title-${selectedSlide.id}`}
                      onChange={(event) =>
                        patchSlide(selectedSlide.id, { prompt: event.target.value })
                      }
                      placeholder='Message, visuals, tone, hierarchy—anything the model should follow for this slide.'
                      rows={6}
                      disabled={isWorking || cookingAll || briefRunning}
                      value={selectedSlide.prompt ?? ""}
                    />
                  : <textarea
                      id={`slide-ai-${selectedSlide.id}`}
                      key={selectedSlide.id}
                      className="slide-ai-instructions"
                      aria-labelledby={`slide-ai-title-${selectedSlide.id}`}
                      defaultValue={slideEditDraftRef.current[selectedSlide.id] ?? ""}
                      onChange={(e) => {
                        slideEditDraftRef.current[selectedSlide.id] = e.target.value;
                      }}
                      placeholder='e.g. "Change bullet 4 to …" — leave blank to rerun from your original slide instructions'
                      rows={7}
                      disabled={isWorking || cookingAll || briefRunning}
                    />
                  }

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
      </section>
      </div>

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
            <div className="presenter-stage" style={deckThemeScopedStyle(theme)}>
              {slide.kind === "layout" && slide.layout ? (
                <LayoutSlide layout={slide.layout} />
              ) : presenterImg ? (
                <img alt={slide.name} className="presenter-image" src={presenterImg} />
              ) : (
                <div className="presenter-empty">
                  <p>{slide.name}</p>
                  <span>Use Instructions for AI below to generate this slide.</span>
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
          <div
            className={`brief-panel ${briefWizardStep === "review" ? "brief-panel--review" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            {briefWizardStep === "compose" ?
              <>
                <p className="eyebrow">Generate from a brief</p>
                <h2 className="brief-title">Spell out the deck.</h2>
                <p className="brief-help">
                  Audience, purpose, tone, key points. Step one: the AI drafts a slide-by-slide plan. Step two: you
                  edit it, uncheck slides you do not want, then create the deck.
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
                      void draftOutlineFromBrief();
                    }}
                    disabled={briefRunning || !briefText.trim()}
                    type="button"
                  >
                    {briefRunning ? "drafting plan…" : "Draft outline"}
                  </button>
                </div>

                <p className="brief-warn">After you approve the plan, creating slides replaces the current deck.</p>
              </>
            : <>
                <p className="eyebrow">Review deck plan</p>
                <h2 className="brief-title">{briefPlanTitle || "Untitled deck"}</h2>
                <p className="brief-help">
                  Edit any field. Uncheck slides to skip them. Only checked slides are added to your deck.
                </p>

                <label className="field-label field-label-soft" htmlFor="brief-plan-deck-title">
                  Deck title
                </label>
                <input
                  id="brief-plan-deck-title"
                  type="text"
                  className="brief-plan-deck-title-input"
                  value={briefPlanTitle}
                  onChange={(e) => setBriefPlanTitle(e.target.value)}
                  disabled={briefRunning}
                />

                <div className="brief-plan-toolbar">
                  <div className="brief-plan-toolbar-left" role="group" aria-label="Include all slides">
                    <button type="button" className="ghost-button" onClick={() => setBriefPlanAllIncluded(true)}>
                      Check all
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setBriefPlanAllIncluded(false)}>
                      Uncheck all
                    </button>
                  </div>
                  <span className="brief-plan-count" aria-live="polite">
                    {briefPlanRows?.filter((r) => r.included).length ?? 0} of {briefPlanRows?.length ?? 0} selected
                  </span>
                </div>

                <div className="brief-plan-list" role="list">
                  {(briefPlanRows ?? []).map((row, index) => (
                    <article key={row.rowId} className="brief-plan-row" role="listitem">
                      <div className="brief-plan-row-head">
                        <label className="brief-plan-checkbox-label">
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={(event) =>
                              updateBriefPlanRow(row.rowId, { included: event.target.checked })
                            }
                            aria-label={`Include slide ${index + 1}: ${row.name || "Untitled"}`}
                          />
                          <span className="brief-plan-idx">{index + 1}</span>
                        </label>
                      </div>
                      <div className="brief-plan-fields">
                        <label className="field-label-soft brief-plan-field-label">Slide title</label>
                        <input
                          type="text"
                          className="brief-plan-line-input"
                          value={row.name}
                          onChange={(e) => updateBriefPlanRow(row.rowId, { name: e.target.value })}
                        />
                        <label className="field-label-soft brief-plan-field-label">Format</label>
                        <select
                          className="brief-plan-format-select"
                          value={row.suggestedFormat}
                          onChange={(e) =>
                            updateBriefPlanRow(row.rowId, {
                              suggestedFormat: normalizeFormat(e.target.value)
                            })
                          }
                        >
                          {FORMAT_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <label className="field-label-soft brief-plan-field-label">Prompt (slide content brief)</label>
                        <textarea
                          className="brief-textarea brief-plan-prompt-area"
                          rows={3}
                          value={row.prompt}
                          onChange={(e) => updateBriefPlanRow(row.rowId, { prompt: e.target.value })}
                        />
                        <label className="field-label-soft brief-plan-field-label">Speaker notes</label>
                        <textarea
                          className="brief-textarea brief-plan-notes-area"
                          rows={2}
                          value={row.notes}
                          onChange={(e) => updateBriefPlanRow(row.rowId, { notes: e.target.value })}
                        />
                      </div>
                    </article>
                  ))}
                </div>

                <div className="brief-actions brief-actions-split">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setBriefWizardStep("compose");
                      setBriefPlanRows(null);
                      setBriefPlanTitle("");
                    }}
                    disabled={briefRunning}
                  >
                    Back to brief
                  </button>
                  <div className="brief-actions-right">
                    <button className="ghost-button" type="button" onClick={() => setBriefOpen(false)}>
                      Cancel
                    </button>
                    <button
                      className="loud-button"
                      type="button"
                      disabled={
                        briefRunning ||
                        cookingAll ||
                        (briefPlanRows?.filter((r) => r.included).length ?? 0) === 0
                      }
                      onClick={() => confirmBriefPlanToDeck()}
                    >
                      Create{" "}
                      {briefPlanRows?.filter((r) => r.included).length ?? 0} slide
                      {(briefPlanRows?.filter((r) => r.included).length ?? 0) === 1 ? "" : "s"}
                    </button>
                  </div>
                </div>
              </>
            }
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
