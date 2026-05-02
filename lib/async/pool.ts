/**
 * Run an array of async tasks with bounded concurrency. Each task gets the
 * batch's AbortSignal so it can cancel itself on stop.
 *
 * Errors are settled per-task: a single failure does not stop the batch.
 * The caller decides what to do with each result via the onSettled callback,
 * or by inspecting the returned Settled[].
 *
 * Why a custom helper instead of a library:
 * - Zero dependencies. ~30 lines.
 * - Per-task abort signal forwarding.
 * - Per-task settlement callback for live UI updates as each one completes.
 */

export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export type Task<T> = (signal: AbortSignal) => Promise<T>;

export type PoolOptions<T> = {
  /** Max number of tasks running concurrently. Must be ≥ 1. */
  limit: number;
  /** Optional batch-level abort. Forwarded to each task. */
  signal?: AbortSignal;
  /** Called as each task settles. Receives the index in the original tasks[]. */
  onSettled?: (index: number, settled: Settled<T>) => void;
};

export async function pool<T>(
  tasks: Array<Task<T>>,
  { limit, signal, onSettled }: PoolOptions<T>
): Promise<Array<Settled<T>>> {
  if (limit < 1) throw new Error("pool: limit must be >= 1");

  const results: Array<Settled<T>> = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      // Honor batch-level cancel between tasks
      if (signal?.aborted) return;

      const myIndex = cursor++;
      const task = tasks[myIndex];

      let settled: Settled<T>;
      try {
        const value = await task(signal ?? new AbortController().signal);
        settled = { status: "fulfilled", value };
      } catch (reason) {
        settled = { status: "rejected", reason };
      }

      results[myIndex] = settled;
      onSettled?.(myIndex, settled);
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
