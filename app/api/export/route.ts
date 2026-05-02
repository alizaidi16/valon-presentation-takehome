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

const COMIC = "Comic Sans MS";
const INK = "1F160F";
const ACCENT = "CC6035";
const PINK = "A81457";
const TEAL = "3F7F92";

function addFooter(slide: pptxgen.Slide, data: SlidePayload) {
  slide.addText(data.name || "Untitled slide", {
    x: 0.4,
    y: 0.25,
    w: 7.6,
    h: 0.4,
    fontFace: "Aptos Display",
    fontSize: 18,
    bold: true,
    color: "141414",
    margin: 0
  });

  slide.addText(data.prompt || "", {
    x: 0.4,
    y: 6.95,
    w: 8.3,
    h: 0.3,
    fontFace: "Aptos",
    fontSize: 8,
    color: "141414",
    margin: 0
  });

  slide.addText(data.note || "", {
    x: 8.95,
    y: 6.8,
    w: 4,
    h: 0.45,
    fontFace: "Aptos",
    fontSize: 8,
    color: "2B1E16",
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
    fontFace: COMIC,
    fontSize: 60,
    bold: true,
    color: PINK,
    align: "center",
    valign: "middle"
  });

  if (layout.subtitle) {
    slide.addText(layout.subtitle, {
      x: 1.5,
      y: 4.3,
      w: 10.3,
      h: 1.2,
      fontFace: COMIC,
      fontSize: 28,
      color: INK,
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
    fontFace: COMIC,
    fontSize: 36,
    bold: true,
    color: ACCENT
  });

  slide.addShape("line", {
    x: 0.5,
    y: 1.6,
    w: 12.3,
    h: 0,
    line: { color: ACCENT, width: 3 }
  });

  const bullets = layout.bullets ?? [];
  const bulletObjects = bullets.map((b) => ({
    text: `★  ${b}`,
    options: { paraSpaceAfter: 12 }
  }));

  slide.addText(bulletObjects, {
    x: 0.5,
    y: 1.75,
    w: 12.3,
    h: 5.4,
    fontFace: COMIC,
    fontSize: 24,
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
    fontFace: COMIC,
    fontSize: 36,
    bold: true,
    color: ACCENT
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
      fill: { color: "FFFFFF", transparency: 40 },
      line: { color: "2A1A11", width: 2 }
    });

    slide.addText(item.title, {
      x: x + 0.18,
      y: y + 0.15,
      w: cardW - 0.36,
      h: 0.55,
      fontFace: COMIC,
      fontSize: 20,
      bold: true,
      color: TEAL
    });

    slide.addText(item.body, {
      x: x + 0.18,
      y: y + 0.75,
      w: cardW - 0.36,
      h: cardH - 0.95,
      fontFace: COMIC,
      fontSize: 14,
      color: INK,
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
      fontFace: COMIC,
      fontSize: 36,
      bold: true,
      color: ACCENT
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
      line: { color: ACCENT, width: 3 }
    });

    slide.addText(stat.value, {
      x,
      y: startY + cardH * 0.15,
      w: cardW,
      h: cardH * 0.5,
      fontFace: COMIC,
      fontSize: 60,
      bold: true,
      color: PINK,
      align: "center",
      valign: "middle"
    });

    slide.addText(stat.label, {
      x,
      y: startY + cardH * 0.68,
      w: cardW,
      h: cardH * 0.28,
      fontFace: COMIC,
      fontSize: 18,
      color: INK,
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
      slide.background = { color: "F4E7B8" };

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
          fill: { color: "FFF7DC" },
          line: { color: "2B1E16", width: 1.5 }
        });
        slide.addText("No image on this slide yet.", {
          x: 1.2,
          y: 3.1,
          w: 7.5,
          h: 0.5,
          fontFace: "Aptos",
          fontSize: 24,
          bold: true,
          color: "2B1E16"
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
