/**
 * Gemini API calls sometimes fail with transient overload (503 UNAVAILABLE,
 * RESOURCE_EXHAUSTED, 429). Short exponential backoff usually succeeds without
 * bothering the user.
 */

export function isRetryableGeminiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    /\b503\b/.test(m) ||
    /\b429\b/.test(m) ||
    /\b529\b/.test(m) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|high demand|overloaded/i.test(m)
  );
}

export async function withGeminiRetries<T>(
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 4;
  const baseDelayMs = options?.baseDelayMs ?? 500;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableGeminiError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const jitter = Math.random() * 250;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1) + jitter));
    }
  }
}
