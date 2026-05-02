import { GoogleGenAI } from "@google/genai";

/**
 * Default models. Override via env if you want different cost/latency
 * tradeoffs without touching the code.
 *
 * - GOOGLE_TEXT_MODEL — used for classification + outline generation.
 *   Defaults to flash-lite, which Google describes as "great for high
 *   throughput tasks like classification or summarization at scale".
 * - GOOGLE_IMAGE_MODEL — used for image generation only.
 */
export const DEFAULT_TEXT_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";

export function getTextModel(): string {
  return process.env.GOOGLE_TEXT_MODEL || DEFAULT_TEXT_MODEL;
}

export function getImageModel(): string {
  return process.env.GOOGLE_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("Missing GOOGLE_API_KEY in your local environment.");
    this.name = "MissingApiKeyError";
  }
}

/**
 * Returns a configured GoogleGenAI client, or throws MissingApiKeyError if
 * the env var isn't set. Routes catch this and surface it as a 500.
 */
export function getClient(): GoogleGenAI {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }
  return new GoogleGenAI({ apiKey });
}
