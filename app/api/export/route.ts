import { NextResponse } from "next/server";
import pptxgen from "pptxgenjs";

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

// Visual constants. Kept in sync with app/globals.css → :root vars and
// app/layout.tsx → next/font setup. PPTX font availability varies by OS:
// Aptos (Microsoft 365 default), Calibri, and Georgia are the most reliable
// cross-platform fallbacks for the pptxgenjs target audience.
const SANS = "Aptos";
const SANS_BOLD = "Aptos Display";
const SERIF = "Georgia";
const INK = "1F160F";
const INK_SOFT = "5C4A3F";
const ACCENT = "B8553A";
const PAPER_BG = "FFFAF0";
const RULE = "D6CDB7";

function addFooter(slide: pptxgen.Slide, data: SlidePayload) {
  slide.addText(data.name || "Untitled slide", {
    x: 0.4,
    y: 0.22,
    w: 7.6,
    h: 0.35,
    fontFace: SANS_BOLD,
    fontSize: 14,
    bold: true,
    color: INK,
    margin: 0
  });

  slide.addText(data.prompt || "", {
    x: 0.4,
    y: 7.0,
    w: 8.3,
    h: 0.3,
    fontFace: SANS,
    fontSize: 8,
    color: INK_SOFT,
    margin: 0
  });

  slide.addText(data.note || "", {
    x: 8.95,
    y: 6.85,
    w: 4,
    h: 0.45,
    fontFace: SANS,
    fontSize: 8,
    color: INK_SOFT,
    margin: 0,
    align: "right"
  });
}

function renderTitleLayout(slide: pptxgen.Slide, layout: LayoutPayload) {
  slide.addText(layout.headline ?? "", {
    x: 1.0,
    y: layout.subtitle ? 1.8 : 2.5,
    w: 11.3,
    h: 2.2,
    fontFace: SERIF,
    fontSize: 56,
    bold: false,
    color: INK,
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
      color: INK_SOFT,
      align: "center",
      valign: "top"
    });
  }
}

function renderBulletsLayout(slide: pptxgen.Slide, layout: LayoutPayload) {
  slide.addText(layout.headline ?? "", {
    x: 0.5,
    y: 0.7,
    w: 12.3,
    h: 0.85,
    fontFace: SERIF,
    fontSize: 32,
    bold: false,
    color: INK,
    charSpacing: -0.5
  });

  slide.addShape("line", {
    x: 0.5,
    y: 1.6,
    w: 12.3,
    h: 0,
    line: { color: RULE, width: 1 }
  });

  const bullets = layout.bullets ?? [];
  const bulletObjects = bullets.map((b) => ({
    text: `•  ${b}`,
    options: { paraSpaceAfter: 14, color: INK }
  }));

  slide.addText(bulletObjects, {
    x: 0.5,
    y: 1.75,
    w: 12.3,
    h: 5.4,
    fontFace: SANS,
    fontSize: 22,
    color: INK,
    valign: "top"
  });
}

function renderGridLayout(slide: pptxgen.Slide, layout: LayoutPayload) {
  slide.addText(layout.headline ?? "", {
    x: 0.5,
    y: 0.7,
    w: 12.3,
    h: 0.85,
    fontFace: SERIF,
    fontSize: 32,
    bold: false,
    color: INK,
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
      line: { color: RULE, width: 1 }
    });

    slide.addShape("rect", {
      x,
      y,
      w: cardW,
      h: 0.05,
      fill: { color: ACCENT },
      line: { color: ACCENT, width: 0 }
    });

    slide.addText(item.title, {
      x: x + 0.22,
      y: y + 0.22,
      w: cardW - 0.44,
      h: 0.55,
      fontFace: SERIF,
      fontSize: 19,
      bold: false,
      color: INK
    });

    slide.addText(item.body, {
      x: x + 0.22,
      y: y + 0.85,
      w: cardW - 0.44,
      h: cardH - 1.05,
      fontFace: SANS,
      fontSize: 13,
      color: INK_SOFT,
      valign: "top"
    });
  });
}

function renderStatsLayout(slide: pptxgen.Slide, layout: LayoutPayload) {
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
      color: INK,
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
      line: { color: RULE, width: 1 }
    });

    slide.addText(stat.value, {
      x,
      y: startY + cardH * 0.15,
      w: cardW,
      h: cardH * 0.5,
      fontFace: SERIF,
      fontSize: 56,
      bold: false,
      color: ACCENT,
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
      color: INK_SOFT,
      align: "center",
      valign: "top"
    });
  });
}

function renderLayoutSlide(slide: pptxgen.Slide, layout: LayoutPayload) {
  switch (layout.kind) {
    case "title":
      renderTitleLayout(slide, layout);
      break;
    case "bullets":
      renderBulletsLayout(slide, layout);
      break;
    case "grid":
      renderGridLayout(slide, layout);
      break;
    case "stats":
      renderStatsLayout(slide, layout);
      break;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      title?: string;
      slides?: SlidePayload[];
    };

    if (!body.slides?.length) {
      return NextResponse.json({ error: "No slides to export." }, { status: 400 });
    }

    const deck = new pptxgen();
    deck.layout = "LAYOUT_WIDE";
    deck.author = "Valon";
    deck.company = "Valon";
    deck.subject = "Valon Presentation Takehome export";
    deck.title = body.title || "Valon Presentation Takehome export";

    for (const slideData of body.slides) {
      const slide = deck.addSlide();
      slide.background = { color: PAPER_BG };

      if (slideData.kind === "layout" && slideData.layout) {
        renderLayoutSlide(slide, slideData.layout);
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
          line: { color: RULE, width: 1 }
        });
        slide.addText("No content on this slide yet.", {
          x: 1.2,
          y: 3.1,
          w: 7.5,
          h: 0.5,
          fontFace: SANS,
          fontSize: 22,
          bold: false,
          color: INK_SOFT
        });
      }

      addFooter(slide, slideData);
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
