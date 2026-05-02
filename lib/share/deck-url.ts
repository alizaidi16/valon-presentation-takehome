/**
 * Compress a deck snapshot into a URL hash fragment for copy-paste sharing.
 * Images are stripped — only structure, prompts, notes, formats, and layout
 * JSON survive the round-trip. Base64 image payloads would blow past browser
 * URL limits; PPTX export is the right path for pixel-perfect handoff.
 *
 * Wire format: #share=<base64url(deflate(utf8(JSON)))>
 * JSON shape is versioned so future migrations can detect old links.
 */

import type { Theme } from "@/lib/ai/themes";

/** Slide fields we persist in a share link (no image bytes, no ephemeral UI). */
export type SharedSlide = {
  id: string;
  name: string;
  prompt: string;
  note: string;
  suggestedFormat?: string;
  kind?: "image" | "layout";
  layout?: unknown;
  status?: string;
  feedback?: string;
};

export type DeckSharePayload = {
  v: 1;
  slides: SharedSlide[];
  selectedId: string;
  theme: Theme;
};

const MAX_HASH_CHARS = 14_000;

function toBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64url"));
  }
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Strip ephemeral / heavy fields before encoding. */
export function toSharePayload(input: {
  slides: Array<Record<string, unknown>>;
  selectedId: string;
  theme: Theme;
}): DeckSharePayload {
  const slides: SharedSlide[] = input.slides.map((s) => {
    const {
      id,
      name,
      prompt,
      note,
      suggestedFormat,
      kind,
      layout,
      status,
      feedback
    } = s;
    return {
      id: String(id),
      name: String(name ?? ""),
      prompt: String(prompt ?? ""),
      note: String(note ?? ""),
      suggestedFormat: suggestedFormat as string | undefined,
      kind: kind as "image" | "layout" | undefined,
      layout: layout as unknown,
      status: status as string | undefined,
      feedback: feedback as string | undefined
    };
  });
  return { v: 1, slides, selectedId: input.selectedId, theme: input.theme };
}

function isSharePayload(x: unknown): x is DeckSharePayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === 1 &&
    Array.isArray(o.slides) &&
    typeof o.selectedId === "string" &&
    typeof o.theme === "object" &&
    o.theme !== null
  );
}

/**
 * Encode to a string safe to place after `#share=` (no `#` prefix in return value).
 */
export async function encodeDeckHash(payload: DeckSharePayload): Promise<string | { error: string }> {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);

  if (typeof CompressionStream === "undefined") {
    return { error: "CompressionStream is not available in this environment." };
  }

  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();

  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const hash = toBase64Url(compressed);

  // #share= + hash must stay reasonable for IE/Edge URL limits (~32k total)
  if (hash.length > MAX_HASH_CHARS) {
    return { error: "Deck is too large to share as a link. Try exporting a .pptx instead." };
  }
  return hash;
}

/** Decode `#share=...` payload (pass the hash *without* the `#share=` prefix). */
export async function decodeDeckHash(fragment: string): Promise<DeckSharePayload | null> {
  const trimmed = fragment.trim();
  if (!trimmed || typeof CompressionStream === "undefined") return null;

  try {
    const compressed = fromBase64Url(trimmed);
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    void writer.write(new Uint8Array(compressed));
    void writer.close();
    const out = await new Response(stream.readable).arrayBuffer();
    const json = new TextDecoder().decode(out);
    const parsed = JSON.parse(json) as unknown;
    return isSharePayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
