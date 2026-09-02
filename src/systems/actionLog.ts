/**
 * The session narrative — what the player did, and what the game did back.
 *
 * ## Why this exists when a trace already does
 *
 * The flight recorder (`traceRecorder.ts`) answers *"what went wrong"*. It
 * writes into a ring buffer and only ever **prints** when a fault triggers a
 * dump. That is the right design for a 2.4-second stall and the wrong one for
 * *"what did the player just press"*, because a player flipping a switch is not
 * a fault, so nothing asks the buffer to print.
 *
 * Measured, 2026-08-27: the tutorial stopped 8 s after starting and the log
 * could not say why. The dumps that session fired at t+6.8, 14.0, 49.2, 53.2 and
 * 107.9 s; the toggle happened at ~t+22 s, in the gap between two dump windows.
 * And it would not have appeared inside one either — `goDormant` emitted no
 * events at all.
 *
 * ## The rule for what belongs here
 *
 * **Log decisions and intent, never mechanism.** If it happened because the
 * player or the game *chose* it, it belongs. If it happened because time passed,
 * it does not — that is the 3,000-events-per-second path that would make this
 * unreadable and distort the frame it is measuring.
 *
 * **And: if `[Profile]` samples it at 1 Hz, it is not an action.** A wave stage
 * change was on the original list and was dropped for exactly this reason —
 * `Lvl 0 active` already prints every second.
 *
 * ## Why identical lines must repeat
 *
 * This module shipped with a repeat-guard — a `Map` of the last `detail` per
 * kind, dropping an unchanged repeat so "a narrative that repeats itself is one
 * nobody reads to the end". **It silently deleted real player actions**, and it
 * took a full session to notice because the loss is invisible: a swallowed line
 * leaves no gap.
 *
 * Measured, `console-logs/2026-08-27-Action-Timeline-Options_after_B_level2.log`:
 * the roster went `turret 0` -> `turret 5`, every one player-built, and the log
 * carried **three** `produce build turret` lines. Two production clicks were
 * gone. Miners (3 built, 3 logged) and racers (2, 2) survived only because
 * those were never clicked twice *in a row*.
 *
 * **The guard confused two different things.** Edge-triggering is right for a
 * *state* — "the tutorial is off" should not reprint every frame. It is wrong
 * for an *action*: pressing Produce twice is two decisions, and the second is
 * not noise just because it matches the first. The same principle that fixed
 * the five spurious lines on 08-27 was then over-applied one layer too high.
 *
 * The guard is also **redundant**. Every state-kind call site now checks its
 * own edge — `wasImmersive` in {@link attachMatchStart}, `wasRetired` in
 * `goDormant`, `next !== current` in `combat.ts`, `loggedRestart` in
 * `scenarioReset.ts`, the `awaiting-start` check in {@link startMatch}. So it
 * protected nothing and cost data.
 *
 * **The rule: suppress at the source that knows the semantics, never in the
 * sink that cannot tell an action from a state.**
 *
 * Design: `RTSVR_repos/devlog/plan/profiler/v2/2026-08-27-Action-Timeline-Options.md`.
 *
 * ## Why it imports nothing at all
 *
 * Five systems call it, including `tablet.ts` and `tutorial.ts` — and **the
 * tablet may not import the tutorial** (`tablet.ts:135`). A module at the very
 * bottom of the import graph is what lets both report without meeting. Same
 * rule, and the same reason, as `traceFlags.ts` and `tutorialWaveGate.ts`.
 *
 * **Zero imports also revised a plan assumption.** A2 said actions would also be
 * written to the flight recorder, so a `[TraceDump]` would carry the narrative
 * inline. `recordEvent` turns out to take **nine numeric fields and no string**
 * (`traceRecorder.ts:450-460`), so the recorder could only have held an opaque
 * "an action of kind 6 happened" marker — the readable half, which is the whole
 * value, cannot go there. Paying an import and a coupling for that was not
 * worth it. The console line is the artefact people read.
 */

/**
 * Ships **enabled**, and deliberately not in `traceFlags.ts`.
 *
 * This is a session record rather than a diagnostic: ~40 lines a session, no
 * per-frame work, and a bug report that arrives with a timeline is worth more
 * than the bytes. A diagnostics-off build should keep it — which is precisely
 * why it does not sit with the flags that build turns off.
 */
const buildEnv = (import.meta as { env?: Record<string, unknown> }).env;
const diagnosticsOverride = String(buildEnv?.VITE_DIAGNOSTICS ?? "").toLowerCase();

/**
 * Same rule as `traceFlags.DIAGNOSTICS_ENABLED`, duplicated rather than
 * imported.
 *
 * This module imports **nothing** — that is what lets `tablet.ts` and
 * `tutorial.ts` both call it when they may not import each other, and what lets
 * the strip-types test runner load it with no harness. Importing the switch
 * would trade that for four lines of shared code, and the leaf property is
 * worth more. A test asserts both files compute it the same way.
 */
const ACTION_LOG_ENABLED: boolean =
  diagnosticsOverride === "on"
    ? true
    : diagnosticsOverride === "off"
      ? false
      : (buildEnv?.PROD as boolean | undefined) !== true;

/**
 * Stable numeric ids for each kind of action.
 *
 * **8 is deliberately absent.** It was "wave stage change", dropped because
 * `[Profile]` already prints `Lvl <n> <stage>` at 1 Hz. The gap is left in the
 * numbering so the omission reads as a decision rather than an oversight.
 */
export const ActionKind = {
  Session: 1,
  Xr: 2,
  MatchStart: 3,
  MatchEnd: 4,
  Restart: 5,
  Tutorial: 6,
  Setting: 7,
  Tab: 9,
  Produce: 10,
  Order: 11,
  Cancel: 12,
  Dump: 13,
  Blocked: 14,
} as const;

export type ActionKindId = (typeof ActionKind)[keyof typeof ActionKind];

const LABEL: Readonly<Record<number, string>> = {
  [ActionKind.Session]: "session",
  [ActionKind.Xr]: "xr",
  [ActionKind.MatchStart]: "match",
  [ActionKind.MatchEnd]: "match",
  [ActionKind.Restart]: "restart",
  [ActionKind.Tutorial]: "tutorial",
  [ActionKind.Setting]: "setting",
  [ActionKind.Tab]: "tab",
  [ActionKind.Produce]: "produce",
  [ActionKind.Order]: "order",
  [ActionKind.Cancel]: "cancel",
  [ActionKind.Dump]: "dump",
  [ActionKind.Blocked]: "blocked",
};

/**
 * Record one player-visible decision.
 *
 * **Unconditional.** There is no repeat-suppression here, and that is a
 * correction rather than an omission — see "Why identical lines must repeat"
 * above.
 *
 * @param detail Human-readable, and **should name the inputs behind the
 * decision, not just its outcome** — the `[GridVisual]` lesson. "the code
 * decided this" and "the player chose this" look identical unless the reason is
 * in the line.
 */
export function logAction(kind: ActionKindId, detail: string): void {
  if (!ACTION_LOG_ENABLED) return;
  console.log(`[Action] ${LABEL[kind] ?? "?"} ${detail}`);
}
