"use client";

import { useEffect, useRef, useState } from "react";
import type {
  BulletsLayout,
  GridLayout,
  SlideLayout,
  StatsLayout,
  TitleLayout
} from "@/lib/ai/helpers";

export type EditableLayoutSlideProps = {
  layout: SlideLayout;
  onCommit: (next: SlideLayout) => void;
  disabled?: boolean;
};

function cloneLayout(l: SlideLayout): SlideLayout {
  switch (l.kind) {
    case "title":
      return { ...l };
    case "bullets":
      return { ...l, bullets: [...l.bullets] };
    case "grid":
      return { ...l, items: l.items.map((it) => ({ ...it })) };
    case "stats":
      return { ...l, stats: l.stats.map((s) => ({ ...s })) };
    default:
      return l;
  }
}

function normalizeCommitted(layout: SlideLayout): SlideLayout {
  if (layout.kind === "title") {
    const t = layout as TitleLayout;
    return {
      kind: "title",
      headline: t.headline.trim(),
      subtitle: t.subtitle?.trim() ? t.subtitle.trim() : undefined
    };
  }
  if (layout.kind === "bullets") {
    const b = layout as BulletsLayout;
    return {
      kind: "bullets",
      headline: b.headline.trim(),
      bullets: b.bullets.map((x) => x.trim())
    };
  }
  if (layout.kind === "grid") {
    const g = layout as GridLayout;
    return {
      kind: "grid",
      headline: g.headline.trim(),
      items: g.items.map((it) => ({
        title: it.title.trim(),
        body: it.body.trim()
      }))
    };
  }
  const s = layout as StatsLayout;
  return {
    kind: "stats",
    headline: s.headline?.trim() || undefined,
    stats: s.stats.map((st) => ({
      value: st.value.trim(),
      label: st.label.trim()
    }))
  };
}

/**
 * In-canvas editing for layout slides. Local draft syncs from `layout` when the
 * serialized payload changes (e.g. after AI regen). Commits on field blur.
 */
export function EditableLayoutSlide({ layout, onCommit, disabled }: EditableLayoutSlideProps) {
  const [draft, setDraft] = useState<SlideLayout>(() => cloneLayout(layout));
  const draftRef = useRef(draft);
  const layoutSig = JSON.stringify(layout);

  const [statsHeadlineOpen, setStatsHeadlineOpen] = useState(() => {
    if (layout.kind !== "stats") return false;
    return Boolean((layout as StatsLayout).headline?.trim());
  });

  useEffect(() => {
    const next = cloneLayout(layout);
    setDraft(next);
    draftRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync when API content changes
  }, [layoutSig]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    let parsed: SlideLayout;
    try {
      parsed = JSON.parse(layoutSig) as SlideLayout;
    } catch {
      return;
    }
    if (parsed.kind !== "stats") {
      setStatsHeadlineOpen(false);
      return;
    }
    setStatsHeadlineOpen(Boolean((parsed as StatsLayout).headline?.trim()));
  }, [layoutSig]);

  function flushCommit() {
    onCommit(normalizeCommitted(cloneLayout(draftRef.current)));
  }

  if (draft.kind === "title") {
    const t = draft as TitleLayout;
    return (
      <div className="layout-slide layout-title layout-slide-editable">
        <textarea
          className="ls-headline ls-editable-field"
          rows={3}
          value={t.headline}
          disabled={disabled}
          aria-label="Title headline"
          onChange={(e) =>
            setDraft((d) =>
              d.kind === "title" ? { ...d, headline: e.target.value } : d
            )
          }
          onBlur={flushCommit}
        />
        <textarea
          className="ls-subtitle ls-editable-field"
          rows={3}
          value={t.subtitle ?? ""}
          disabled={disabled}
          placeholder="Subtitle (optional)"
          aria-label="Title subtitle"
          onChange={(e) =>
            setDraft((d) =>
              d.kind === "title"
                ? { ...d, subtitle: e.target.value || undefined }
                : d
            )
          }
          onBlur={flushCommit}
        />
      </div>
    );
  }

  if (draft.kind === "bullets") {
    const b = draft as BulletsLayout;
    return (
      <div className="layout-slide layout-bullets layout-slide-editable">
        <div className="ls-editable-head-block">
          <textarea
            className="ls-section-headline ls-editable-field"
            rows={2}
            value={b.headline}
            disabled={disabled}
            aria-label="Section headline"
            onChange={(e) => setDraft({ ...b, headline: e.target.value })}
            onBlur={flushCommit}
          />
          <div className="ls-section-accent-bar" aria-hidden />
        </div>
        <ul className="ls-bullet-list" aria-label="Bullet list">
          {b.bullets.map((bullet, i) => (
            <li key={i} className="ls-bullet-item">
              <textarea
                className="ls-editable-field ls-editable-bullet"
                rows={2}
                value={bullet}
                disabled={disabled}
                aria-label={`Bullet ${i + 1}`}
                onChange={(e) => {
                  const next = [...b.bullets];
                  next[i] = e.target.value;
                  setDraft({ ...b, bullets: next });
                }}
                onBlur={flushCommit}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (draft.kind === "grid") {
    const g = draft as GridLayout;
    return (
      <div className="layout-slide layout-grid layout-slide-editable">
        <div className="ls-editable-head-block">
          <textarea
            className="ls-section-headline ls-editable-field"
            rows={2}
            value={g.headline}
            disabled={disabled}
            aria-label="Grid section headline"
            onChange={(e) => setDraft({ ...g, headline: e.target.value })}
            onBlur={flushCommit}
          />
          <div className="ls-section-accent-bar" aria-hidden />
        </div>
        <div className="ls-grid-items">
          {g.items.map((item, i) => (
            <div key={i} className="ls-grid-item">
              <textarea
                className="ls-grid-title ls-editable-field"
                rows={2}
                value={item.title}
                disabled={disabled}
                aria-label={`Grid item ${i + 1} title`}
                onChange={(e) => {
                  const items = g.items.map((it, j) =>
                    j === i ? { ...it, title: e.target.value } : it
                  );
                  setDraft({ ...g, items });
                }}
                onBlur={flushCommit}
              />
              <textarea
                className="ls-grid-body ls-editable-field"
                rows={4}
                value={item.body}
                disabled={disabled}
                aria-label={`Grid item ${i + 1} body`}
                onChange={(e) => {
                  const items = g.items.map((it, j) =>
                    j === i ? { ...it, body: e.target.value } : it
                  );
                  setDraft({ ...g, items });
                }}
                onBlur={flushCommit}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const s = draft as StatsLayout;

  return (
    <div className="layout-slide layout-stats layout-slide-editable">
      {statsHeadlineOpen ?
        <div className="ls-editable-head-block">
          <textarea
            className="ls-section-headline ls-editable-field"
            rows={2}
            value={s.headline ?? ""}
            disabled={disabled}
            placeholder="Section headline"
            aria-label="Stats headline"
            onChange={(e) => setDraft({ ...s, headline: e.target.value || undefined })}
            onBlur={flushCommit}
          />
          <div className="ls-section-accent-bar" aria-hidden />
        </div>
      : !disabled ?
        <div className="stats-headline-add-row">
          <button
            type="button"
            className="stats-add-headline"
            onClick={() => {
              setStatsHeadlineOpen(true);
              setDraft({ ...s, headline: "" });
            }}
          >
            + Section headline
          </button>
        </div>
      : null}
      <div className="ls-stats-row">
        {s.stats.map((st, i) => (
          <div key={i} className="ls-stat-item">
            <input
              type="text"
              className="ls-stat-value ls-editable-field"
              value={st.value}
              disabled={disabled}
              aria-label={`Stat ${i + 1} value`}
              onChange={(e) => {
                const stats = s.stats.map((x, j) =>
                  j === i ? { ...x, value: e.target.value } : x
                );
                setDraft({ ...s, stats });
              }}
              onBlur={flushCommit}
            />
            <input
              type="text"
              className="ls-stat-label ls-editable-field"
              value={st.label}
              disabled={disabled}
              aria-label={`Stat ${i + 1} label`}
              onChange={(e) => {
                const stats = s.stats.map((x, j) =>
                  j === i ? { ...x, label: e.target.value } : x
                );
                setDraft({ ...s, stats });
              }}
              onBlur={flushCommit}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
