import { describe, expect, it } from "vitest";

import { HistoryStack } from "@/lib/history/stack";

type Snap = { v: number };

describe("HistoryStack", () => {
  it("starts empty", () => {
    const h = new HistoryStack<Snap>();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.pastSize()).toBe(0);
    expect(h.futureSize()).toBe(0);
  });

  it("snapshots push onto past and clear future", () => {
    const h = new HistoryStack<Snap>();
    h.snapshot({ v: 1 });
    expect(h.canUndo()).toBe(true);
    expect(h.pastSize()).toBe(1);
    expect(h.canRedo()).toBe(false);

    h.snapshot({ v: 2 });
    expect(h.pastSize()).toBe(2);
  });

  it("undo returns previous and parks current on future", () => {
    const h = new HistoryStack<Snap>();
    h.snapshot({ v: 1 });
    h.snapshot({ v: 2 });

    const prev = h.undo({ v: 3 });
    expect(prev).toEqual({ v: 2 });
    expect(h.canRedo()).toBe(true);
    expect(h.futureSize()).toBe(1);
  });

  it("undo returns null when past is empty", () => {
    const h = new HistoryStack<Snap>();
    expect(h.undo({ v: 1 })).toBeNull();
  });

  it("redo applies parked future state", () => {
    const h = new HistoryStack<Snap>();
    h.snapshot({ v: 1 });
    h.undo({ v: 2 });
    const next = h.redo({ v: 1 });
    expect(next).toEqual({ v: 2 });
  });

  it("redo returns null when future is empty", () => {
    const h = new HistoryStack<Snap>();
    expect(h.redo({ v: 1 })).toBeNull();
  });

  it("snapshot after undo clears the redo path", () => {
    const h = new HistoryStack<Snap>();
    h.snapshot({ v: 1 });
    h.snapshot({ v: 2 });
    h.undo({ v: 3 }); // future = [{v:3}]
    expect(h.canRedo()).toBe(true);

    h.snapshot({ v: 4 }); // should drop the redo path
    expect(h.canRedo()).toBe(false);
  });

  it("respects the cap by dropping the oldest past entry", () => {
    const h = new HistoryStack<Snap>(3);
    h.snapshot({ v: 1 });
    h.snapshot({ v: 2 });
    h.snapshot({ v: 3 });
    h.snapshot({ v: 4 }); // drops {v:1}

    expect(h.pastSize()).toBe(3);
    // Undo three times — the 4th would have been {v:1}, but it was dropped
    h.undo({ v: 5 }); // returns {v:4}
    h.undo({ v: 4 }); // returns {v:3}
    h.undo({ v: 3 }); // returns {v:2}
    expect(h.canUndo()).toBe(false);
  });

  it("respects the cap on future stack too", () => {
    const h = new HistoryStack<Snap>(2);
    h.snapshot({ v: 1 });
    h.snapshot({ v: 2 });
    h.snapshot({ v: 3 });
    // past now [v:2, v:3] (cap 2)
    h.undo({ v: 4 }); // past=[v:2], future=[v:4]
    h.undo({ v: 3 }); // past=[],     future=[v:4, v:3]
    expect(h.futureSize()).toBe(2);
  });

  it("reset clears both stacks", () => {
    const h = new HistoryStack<Snap>();
    h.snapshot({ v: 1 });
    h.undo({ v: 2 });
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it("rejects cap < 1", () => {
    expect(() => new HistoryStack<Snap>(0)).toThrow();
  });

  it("works with arbitrary snapshot shapes (round-trip equality)", () => {
    type Deck = { slides: { id: string; name: string }[]; selected: string };
    const h = new HistoryStack<Deck>();
    const initial: Deck = {
      slides: [{ id: "a", name: "alpha" }],
      selected: "a"
    };
    h.snapshot(initial);

    const after: Deck = {
      slides: [
        { id: "a", name: "alpha" },
        { id: "b", name: "beta" }
      ],
      selected: "b"
    };

    const restored = h.undo(after);
    expect(restored).toEqual(initial);
  });
});
