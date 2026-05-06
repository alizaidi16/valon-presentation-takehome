import type { SlideLayout } from "@/lib/ai/helpers";

export type SlideThumbnailHeadingInput = {
  name: string;
  prompt: string;
  layout?: SlideLayout | undefined;
};

/**
 * Label for sidebar thumbnails: layout headline when available, else first line
 * of prompt (truncated), else `name`. When `listIndex === 0`, uses `name` when
 * non-empty so the first thumb matches the slide title.
 */
export function slideThumbnailHeading(
  slide: SlideThumbnailHeadingInput,
  options?: { listIndex?: number }
): string {
  if (options?.listIndex === 0) {
    const n = slide.name.trim();
    if (n) {
      return n.length > 72 ? `${n.slice(0, 69)}…` : n;
    }
  }

  const layout = slide.layout;
  if (layout) {
    switch (layout.kind) {
      case "title": {
        const h = layout.headline.trim();
        if (h) return h;
        const line = slide.prompt.trim().split(/\n/)[0]?.trim() ?? "";
        if (line) {
          return line.length > 72 ? `${line.slice(0, 69)}…` : line;
        }
        return "\u2014";
      }
      case "bullets":
      case "grid": {
        const h = layout.headline.trim();
        return h || slide.name;
      }
      case "stats": {
        const h = layout.headline?.trim();
        if (h) return h;
        const first = layout.stats[0];
        if (first) {
          const bit = `${first.value} ${first.label}`.trim();
          if (bit) return bit;
        }
        return slide.name;
      }
      default:
        return slide.name;
    }
  }

  const line = slide.prompt.trim().split(/\n/)[0]?.trim() ?? "";
  if (line) {
    return line.length > 72 ? `${line.slice(0, 69)}…` : line;
  }
  return slide.name;
}
