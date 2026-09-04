import { ActionKind, logAction } from "./actionLog.ts";
import { resourceLifetimeSnapshot } from "./resourceLifetime.ts";

/**
 * The one line that records a wave ending.
 *
 * ## Why this is not in `combat.ts`
 *
 * It needs the resource tracker, and `combat.ts` is a hot per-frame system that
 * should not grow a diagnostics dependency. Keeping it here means the wave
 * system calls one function and knows nothing about how the line is composed.
 *
 * ## What it carries, and why each part
 *
 * ```text
 * [Action] wave 2 -> 3 cleared in 67s scenarioLive=63 created=+30 disposed=+2
 * ```
 *
 * - **`2 -> 3` and the duration** are the part that must survive diagnostics
 *   being off. Before this line existed, wave pacing could only be recovered
 *   from the `Lvl N` prefix on profile blocks — ±1s, and gone entirely in a
 *   production build. Every balance question is asked along this axis.
 * - **`scenarioLive`** is the board's weight at the moment the wave turned
 *   over: the count a leak would show up in.
 * - **`created` / `disposed`** are the deltas *for the wave that just ended*.
 *   They are what makes per-wave resource accounting a record rather than a
 *   reconstruction — and they show the wave-preparation burst directly, since
 *   the next wave's aliens are built during the countdown that follows.
 *
 * The resource half is omitted when nothing is tracked, rather than printed as
 * zeros: in a diagnostics-off build `created=+0 disposed=+0` would read as
 * "nothing was created", which is false.
 */

let lastTransitionMs = 0;
let lastCreated = 0;
let lastDisposed = 0;

/** Reset at match start and on a scenario reset, so wave 1 is timed from 0. */
export function resetWaveTransitionLog(): void {
  lastTransitionMs = 0;
  lastCreated = 0;
  lastDisposed = 0;
}

export function logWaveTransition(from: number, to: number): void {
  const now = performance.now();
  // The first advance of a match has no previous wave to time, so it reports
  // the transition without a duration rather than inventing one from boot.
  const seconds = lastTransitionMs === 0 ? null : (now - lastTransitionMs) / 1000;
  lastTransitionMs = now;

  const scenario = resourceLifetimeSnapshot().byScope.get("scenario");
  let detail = "";
  if (scenario) {
    const created = scenario.created - lastCreated;
    const disposed = scenario.disposed - lastDisposed;
    lastCreated = scenario.created;
    lastDisposed = scenario.disposed;
    detail =
      ` scenarioLive=${scenario.outstanding}` +
      ` created=+${created} disposed=+${disposed}`;
  }

  logAction(
    ActionKind.Wave,
    `${from} -> ${to}${seconds === null ? "" : ` cleared in ${seconds.toFixed(0)}s`}${detail}`,
  );
}
