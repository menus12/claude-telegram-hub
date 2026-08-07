/**
 * A cancelable one-shot timer, abstracted so time-based hub logic (presence
 * debounce, response SLA) is deterministic under test. `schedule(fn, ms)` returns
 * a function that cancels the pending timer.
 */
export type Scheduler = (fn: () => void, delayMs: number) => () => void;

/** The production scheduler: `setTimeout`, unref'd so it never holds the process open. */
export const realScheduler: Scheduler = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
