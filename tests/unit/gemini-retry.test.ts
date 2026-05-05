/**
 * Unit tests for Gemini transient-error retry helper.
 */

import { describe, it, expect, vi } from "vitest";
import { isRetryableGeminiError, withGeminiRetries } from "../../lib/ai/gemini-retry";

describe("isRetryableGeminiError", () => {
  it("detects stringified 503 UNAVAILABLE body", () => {
    const err = new Error(
      JSON.stringify({
        error: {
          code: 503,
          message: "This model is currently experiencing high demand.",
          status: "UNAVAILABLE"
        }
      })
    );
    expect(isRetryableGeminiError(err)).toBe(true);
  });

  it("detects high demand wording", () => {
    expect(isRetryableGeminiError(new Error("high demand — try again"))).toBe(true);
  });

  it("detects 429", () => {
    expect(isRetryableGeminiError(new Error("quota exceeded 429"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRetryableGeminiError(new Error("invalid JSON in request"))).toBe(false);
    expect(isRetryableGeminiError("string")).toBe(false);
  });
});

describe("withGeminiRetries", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withGeminiRetries(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds", async () => {
    const payload = JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error(payload))
      .mockResolvedValueOnce("ok");
    await expect(
      withGeminiRetries(fn, { maxAttempts: 4, baseDelayMs: 1 })
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad request"));
    await expect(withGeminiRetries(fn, { baseDelayMs: 1 })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error('{"error":{"code":503}}'));
    await expect(withGeminiRetries(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
