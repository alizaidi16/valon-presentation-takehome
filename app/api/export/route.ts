import { NextResponse } from "next/server";
import pptxgen from "pptxgenjs";
import { DEFAULT_THEME, getPresetTheme, type Theme } from "@/lib/ai/themes";

type LayoutPayload = {
  kind: string;
  headline?: string;
  subtitle?: string;
  bullets?: string[];
  items?: Array<{ title: string; body: string }>;
  stats?: Array<{ value: string; label: string }>;
};

type SlidePayload = {
  name: string;
  prompt: string;
  note?: string;
  kind?: "image" | "layout";
  imageData?: string;
  layout?: LayoutPayload;
};

type ExportBody = {
  title?: string;
  slides?: SlidePayload[];
  /** Either a preset theme id ("editorial" | "monochrome" | "pitch"), or
   * a full theme object (used when the deck has a "locked" style extracted
   * from a generated image). Defaults to editorial when omitted. */
  theme?: string | Theme;
};

// Font choices stay constant across themes — colors come from Theme.pptx.
// PPTX font availability varies by OS: Aptos (Microsoft 365 default),
// Calibri, and Georgia are the most reliable cross-platform fallbacks.
const SANS = "Aptos";
const SANS_BOLD = "Aptos Display";
const SERIF = "Georgia";

type ThemeColors = Theme["pptx"];

function addFooter(slide: pptxgen.Slide, data: SlidePayload, c: ThemeColors) {
  const isTitleSlide = data.kind === "layout" && data.layout?.kind === "title";

  /** Title decks carry the headline in-body; omit outline name band at top. */
  if (!isTitleSlide) {
    slide.addText(data.name || "Untitled slide", {
      x: 0.4,
      y: 0.22,
      w: 7.6,
      h: 0.35,
      fontFace: SANS_BOLD,
      fontSize: 14,
      bold: true,
      color: c.ink,
      margin: 0
    });
  }

  slide.addText(data.prompt || "", {
    x: 0.4,
    y: 7.0,
    w: 8.3,
    h: 0.3,
    fontFace: SANS,
    fontSize: 8,
    color: c.inkSoft,
    margin: 0
  });

  slide.addText(data.note || "", {
    x: 8.95,
    y: 6.85,
    w: 4,
    h: 0.45,
    fontFace: SANS,
    fontSize: 8,
    color: c.inkSoft,
    margin: 0,
    align: "right"
  });
}

function renderTitleLayout(slide: pptxgen.Slide, layout: LayoutPayload, c: ThemeColors) {
  slide.addText(layout.headline ?? "", {
    x: 1.0,
    y: layout.subtitle ? 1.8 : 2.5,
    w: 11.3,
    h: 2.2,
    fontFace: SERIF,
    fontSize: 56,
    bold: false,
    color: c.ink,
    align: "center",
    valign: "middle",
    charSpacing: -1
  });

  if (layout.subtitle) {
    slide.addText(layout.subtitle, {
      x: 1.5,
      y: 4.3,
      w: 10.3,
      h: 1.2,
      fontFace: SANS,
      fontSize: 24,
      color: c.inkSoft,
      align: "center",
      valign: "top"
    });
  }
}

function renderBulletsLayout(slide: pptxgen.Slide, layout: LayoutPayload, c: ThemeColors) {
  slide.addText(layout.headline ?? "", {
    x: 0.5,
    y: 0.7,
    w: 12.3,
    h: 0.85,
    fontFace: SERIF,
    fontSize: 32,
    bold: false,
    color: c.ink,
    charSpacing: -0.5
  });

  slide.addShape("line", {
    x: 0.5,
    y: 1.6,
    w: 12.3,
    h: 0,
    line: { color: c.rule, width: 1 }
  });

  const bullets = layout.bullets ?? [];
  const bulletObjects = bullets.map((b) => ({
    text: `•  ${b}`,
    options: { paraSpaceAfter: 14, color: c.ink }
  }));

  slide.addText(bulletObjects, {
    x: 0.5,
    y: 1.75,
    w: 12.3,
    h: 5.4,
    fontFace: SANS,
    fontSize: 22,
    color: c.ink,
    valign: "top"
  });
}

function renderGridLayout(slide: pptxgen.Slide, layout: LayoutPayload, c: ThemeColors) {
  slide.addText(layout.headline ?? "", {
    x: 0.5,
    y: 0.7,
    w: 12.3,
    h: 0.85,
    fontFace: SERIF,
    fontSize: 32,
    bold: false,
    color: c.ink,
    charSpacing: -0.5
  });

  const items = layout.items ?? [];
  const cols = items.length <= 2 ? 2 : items.length <= 3 ? 3 : 2;
  const rows = Math.ceil(items.length / cols);
  const cardW = (12.3 - 0.2 * (cols - 1)) / cols;
  const cardH = (5.5 - 0.2 * (rows - 1)) / rows;
  const startY = 1.75;

  items.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 0.5 + col * (cardW + 0.2);
    const y = startY + row * (cardH + 0.2);

    slide.addShape("rect", {
      x,
      y,
      w: cardW,
      h: cardH,
      fill: { color: "FFFFFF", transparency: 45 },
      line: { color: c.rule, width: 1 }
    });

    slide.addShape("rect", {
      x,
      y,
      w: cardW,
      h: 0.05,
      fill: { color: c.accent },
      line: { color: c.accent, width: 0 }
    });

    slide.addText(item.title, {
      x: x + 0.22,
      y: y + 0.22,
      w: cardW - 0.44,
      h: 0.55,
      fontFace: SERIF,
      fontSize: 19,
      bold: false,
      color: c.ink
    });

    slide.addText(item.body, {
      x: x + 0.22,
      y: y + 0.85,
      w: cardW - 0.44,
      h: cardH - 1.05,
      fontFace: SANS,
      fontSize: 13,
      color: c.inkSoft,
      valign: "top"
    });
  });
}

function renderStatsLayout(slide: pptxgen.Slide, layout: LayoutPayload, c: ThemeColors) {
  let startY = 1.0;

  if (layout.headline) {
    slide.addText(layout.headline, {
      x: 0.5,
      y: 0.7,
      w: 12.3,
      h: 0.85,
      fontFace: SERIF,
      fontSize: 32,
      bold: false,
      color: c.ink,
      charSpacing: -0.5
    });
    startY = 1.75;
  }

  const stats = layout.stats ?? [];
  const cardW = (12.3 - 0.3 * (stats.length - 1)) / stats.length;
  const cardH = 7.5 - startY - 0.4;

  stats.forEach((stat, i) => {
    const x = 0.5 + i * (cardW + 0.3);

    slide.addShape("rect", {
      x,
      y: startY,
      w: cardW,
      h: cardH,
      fill: { color: "FFFFFF", transparency: 50 },
      line: { color: c.rule, width: 1 }
    });

    slide.addText(stat.value, {
      x,
      y: startY + cardH * 0.15,
      w: cardW,
      h: cardH * 0.5,
      fontFace: SERIF,
      fontSize: 56,
      bold: false,
      color: c.accent,
      align: "center",
      valign: "middle",
      charSpacing: -1
    });

    slide.addText(stat.label, {
      x,
      y: startY + cardH * 0.68,
      w: cardW,
      h: cardH * 0.28,
      fontFace: SANS,
      fontSize: 16,
      color: c.inkSoft,
      align: "center",
      valign: "top"
    });
  });
}

function renderLayoutSlide(slide: pptxgen.Slide, layout: LayoutPayload, c: ThemeColors) {
  switch (layout.kind) {
    case "title":
      renderTitleLayout(slide, layout, c);
      break;
    case "bullets":
      renderBulletsLayout(slide, layout, c);
      break;
    case "grid":
      renderGridLayout(slide, layout, c);
      break;
    case "stats":
      renderStatsLayout(slide, layout, c);
      break;
  }
}

/**
 * Resolve the theme from a request body. Accepts a preset id, a full theme
 * object (for "locked" themes extracted from a slide), or nothing (defaults
 * to editorial). Validates that arbitrary objects have the .pptx field we
 * need so a malformed payload doesn't throw mid-render.
 */
function resolveTheme(input: ExportBody["theme"]): Theme {
  if (!input) return DEFAULT_THEME;
  if (typeof input === "string") {
    return getPresetTheme(input) ?? DEFAULT_THEME;
  }
  if (input && typeof input === "object" && input.pptx && typeof input.pptx === "object") {
    return input;
  }
  return DEFAULT_THEME;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ExportBody;

    if (!body.slides?.length) {
      return NextResponse.json({ error: "No slides to export." }, { status: 400 });
    }

    const theme = resolveTheme(body.theme);
    const c = theme.pptx;

    const deck = new pptxgen();
    deck.layout = "LAYOUT_WIDE";
    deck.author = "Valon";
    deck.company = "Valon";
    deck.subject = "Valon Presentation Takehome export";
    deck.title = body.title || "Valon Presentation Takehome export";

    for (const slideData of body.slides) {
      const slide = deck.addSlide();
      slide.background = { color: c.paper };

      if (slideData.kind === "layout" && slideData.layout) {
        renderLayoutSlide(slide, slideData.layout, c);
      } else if (slideData.imageData) {
        slide.addImage({
          data: slideData.imageData,
          x: 0,
          y: 0,
          w: 13.333,
          h: 7.5
        });
      } else {
        slide.addShape("rect", {
          x: 0.7,
          y: 1.1,
          w: 11.9,
          h: 4.9,
          fill: { color: "FFFFFF" },
          line: { color: c.rule, width: 1 }
        });
        slide.addText("No content on this slide yet.", {
          x: 1.2,
          y: 3.1,
          w: 7.5,
          h: 0.5,
          fontFace: SANS,
          fontSize: 22,
          bold: false,
          color: c.inkSoft
        });
      }

      addFooter(slide, slideData, c);
    }

    const file = await deck.write({ outputType: "nodebuffer" });

    let responseBody: BodyInit;

    if (typeof file === "string" || file instanceof Blob || file instanceof ArrayBuffer) {
      responseBody = file;
    } else {
      const arrayBuffer = new ArrayBuffer(file.byteLength);
      new Uint8Array(arrayBuffer).set(file);
      responseBody = arrayBuffer;
    }

    return new Response(responseBody, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": 'attachment; filename="valon-presentation-takehome-export.pptx"'
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong while exporting.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
