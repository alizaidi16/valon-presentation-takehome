/**
 * Bounded undo/redo stack. Holds up to `cap` past + future snapshots,
 * dropping the oldest entries when the cap is hit. The caller decides
 * what to snapshot — the stack is generic over the snapshot type.
 *
 * Design notes:
 * - Snapshot BEFORE mutating, not after. The stack tracks the state you
 *   want to restore TO when undoing — that's the pre-mutation state.
 *   Pattern: `stack.snapshot(currentState); applyMutation(...);`.
 * - undo() and redo() take the live current state so they can park it
 *   on the opposite stack. This avoids needing a separate "current"
 *   pointer and lets React stay the source of truth.
 * - Default cap of 50 covers typical session use without unbounded memory
 *   growth from large image-data slides (each snapshot is full deep clone
 *   responsibility of the caller).
 */
export class HistoryStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private readonly cap: number;

  constructor(cap = 50) {
    if (cap < 1) throw new Error("HistoryStack cap must be at least 1");
    this.cap = cap;
  }

  /** Push the current state onto the past stack and clear any redo path.
   * Call BEFORE mutating, with the state as it is right now. */
  snapshot(state: T): void {
    this.past.push(state);
    if (this.past.length > this.cap) {
      this.past.shift();
    }
    this.future = [];
  }

  /** Pop the most recent past snapshot and return it. The caller's
   * `currentState` (about to be replaced by the returned value) gets
   * pushed onto the future stack so it can be re-applied via redo(). */
  undo(currentState: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(currentState);
    if (this.future.length > this.cap) this.future.shift();
    return previous;
  }

  /** Mirror of undo: pop the most recent future snapshot and return it. */
  redo(currentState: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(currentState);
    if (this.past.length > this.cap) this.past.shift();
    return next;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Hard reset; useful on initial load or after restoring from URL. */
  reset(): void {
    this.past = [];
    this.future = [];
  }

  /** Inspection helpers, mainly for tests + debugging. */
  pastSize(): number {
    return this.past.length;
  }

  futureSize(): number {
    return this.future.length;
  }
}
