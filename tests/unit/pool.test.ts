/**
 * Unit tests for the bounded-concurrency async pool.
 */

import { describe, it, expect, vi } from "vitest";
import { pool, type Settled } from "../../lib/async/pool";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("pool — basic correctness", () => {
  it("returns settled results in original task order", async () => {
    const tasks = [
      async () => {
        await wait(20);
        return "a";
      },
      async () => {
        await wait(5);
        return "b";
      },
      async () => {
        await wait(10);
        return "c";
      }
    ];

    const results = await pool(tasks, { limit: 3 });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("handles tasks shorter than limit", async () => {
    const results = await pool(
      [async () => 1, async () => 2],
      { limit: 5 }
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("handles empty task list", async () => {
    const results = await pool([], { limit: 3 });
    expect(results).toEqual([]);
  });

  it("throws synchronously if limit < 1", async () => {
    await expect(pool([async () => 1], { limit: 0 })).rejects.toThrow(/limit must be >= 1/);
  });
});

describe("pool — concurrency bounds", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    const makeTask = () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await wait(15);
      inFlight--;
      return null;
    };

    const tasks = Array.from({ length: 10 }, makeTask);
    await pool(tasks, { limit: 3 });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // sanity: actually parallelized
  });

  it("limit=1 runs serially", async () => {
    const log: number[] = [];

    const tasks = [1, 2, 3].map((n) => async () => {
      log.push(n);
      await wait(5);
      log.push(-n);
      return n;
    });

    await pool(tasks, { limit: 1 });
    expect(log).toEqual([1, -1, 2, -2, 3, -3]);
  });
});

describe("pool — failure isolation", () => {
  it("one failure does not stop the batch", async () => {
    const tasks = [
      async () => "ok",
      async () => {
        throw new Error("boom");
      },
      async () => "also ok"
    ];

    const results = await pool(tasks, { limit: 2 });
    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: "also ok" });
  });

  it("captures error reasons", async () => {
    const results = await pool(
      [
        async () => {
          throw new Error("specific message");
        }
      ],
      { limit: 1 }
    );

    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected") {
      expect((results[0].reason as Error).message).toBe("specific message");
    }
  });
});

describe("pool — abort", () => {
  it("stops kicking off new tasks when signal aborts mid-batch", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      started.push(i);
      await wait(20);
      return i;
    });

    const promise = pool(tasks, { limit: 2, signal: controller.signal });
    await wait(15); // let first 2 start
    controller.abort();
    await promise;

    // Can't predict exactly how many started, but it should be << 10
    expect(started.length).toBeLessThan(10);
  });

  it("forwards signal to each task", async () => {
    const seenSignals: AbortSignal[] = [];

    await pool(
      [
        async (signal) => {
          seenSignals.push(signal);
          return 1;
        },
        async (signal) => {
          seenSignals.push(signal);
          return 2;
        }
      ],
      { limit: 2 }
    );

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("pool — onSettled callback", () => {
  it("fires per task with correct index", async () => {
    const calls: Array<{ index: number; settled: Settled<string> }> = [];

    await pool(
      [
        async () => "a",
        async () => "b",
        async () => "c"
      ],
      {
        limit: 2,
        onSettled: (index, settled) => {
          calls.push({ index, settled });
        }
      }
    );

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.index).sort()).toEqual([0, 1, 2]);
  });

  it("fires callback even on rejection", async () => {
    const onSettled = vi.fn();
    await pool(
      [
        async () => {
          throw new Error("x");
        }
      ],
      { limit: 1, onSettled }
    );

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][1].status).toBe("rejected");
  });
});
