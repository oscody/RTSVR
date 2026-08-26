/**
 * The tutorial's grip on the wave system — a releasable token, not a boolean.
 *
 * Deliberately imports **nothing**. `wave.ts` and `waveCatalog.ts` read it, and
 * `tutorial.ts` writes it; a module with no imports of its own cannot be the
 * middle of an import cycle no matter which direction the graph grows.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * **When the tutorial is off, every reader here returns today's behaviour**:
 * `holdsCountdown` false, an unlimited release allowance, no spawn anchor. That
 * is the property the whole phase rests on — the wave system is the game's
 * core loop, and the tutorial must be incapable of changing it while disabled.
 */

export interface TutorialSpawnAnchor {
  x: number;
  y: number;
}

/**
 * Is the tutorial currently governing the wave system?
 *
 * Note this is NOT the same as "the tutorial card is on screen". The card is
 * VR-only; the wave hold is not. A tutorial run sitting in the 2D preview must
 * still hold its waves, or the player puts the headset on to find wave 0
 * already half-spawned.
 */
let governing = false;
/** Freeze the countdown: Act 1 ends on the player, never on a clock. */
let holdsCountdown = false;
/**
 * Total aliens the tutorial permits to have been released so far. Monotonic
 * within a run, derived from the drills — see `releaseBudget`.
 */
let releaseBudget = 0;
/** Where the first alien should land, resolved from the live board. */
let spawnAnchor: TutorialSpawnAnchor | null = null;
/** Monotonic marker used to verify initialization-time gate publication. */
let revision = 0;
/**
 * Has the tutorial finished or been skipped in this match?
 *
 * Lives here rather than in `tutorial.ts` for the same reason everything else
 * in this file does: `tablet.ts` needs to read it to answer "why did the toggle
 * do nothing", and the tablet is forbidden from importing the tutorial system
 * (`tablet.ts:135-136` — the dependency runs tutorial -> tablet only).
 */
let leftThisMatch = false;

/**
 * True when switching the tutorial back on would need a Restart to take effect.
 *
 * Re-enabling mid-match cannot resume the script: it assumes wave 0 and a fresh
 * base, and dropping back into a drill would fight the wave system for control.
 */
export function tutorialRequiresRestart(): boolean {
  return leftThisMatch;
}

/** Set by `TutorialSystem` when the script finishes or the player skips. */
export function markTutorialLeft(): void {
  leftThisMatch = true;
}

/** Cleared by `resetTutorial()` — Restart is the one path that re-arms it. */
export function clearTutorialLeft(): void {
  leftThisMatch = false;
}

/** Published by TutorialSystem every sample. */
export function setTutorialWaveGate(state: {
  governing: boolean;
  holdsCountdown: boolean;
  releaseBudget: number;
  spawnAnchor: TutorialSpawnAnchor | null;
}): void {
  governing = state.governing;
  holdsCountdown = state.holdsCountdown;
  releaseBudget = state.releaseBudget;
  spawnAnchor = state.spawnAnchor;
  revision += 1;
}

/** Full release — the tutorial is off, finished, or the match has ended. */
export function clearTutorialWaveGate(): void {
  governing = false;
  holdsCountdown = false;
  releaseBudget = 0;
  spawnAnchor = null;
  revision += 1;
}

/** Revision of the last publish or intentional clear. */
export function tutorialWaveGateRevision(): number {
  return revision;
}

export function isTutorialGoverningWaves(): boolean {
  return governing;
}

/** True while Act 1 is running: the wave countdown must not tick. */
export function tutorialHoldsCountdown(): boolean {
  return governing && holdsCountdown;
}

/**
 * How many more aliens may be released, given how many already have been.
 *
 * `Infinity` when the tutorial is not governing, so the caller's `Math.min`
 * against it is a no-op and the normal ladder is untouched.
 */
export function tutorialReleaseAllowance(alreadyReleased: number): number {
  if (!governing) return Number.POSITIVE_INFINITY;
  return Math.max(0, releaseBudget - alreadyReleased);
}

/**
 * Where the tutorial's first alien should spawn, or null for the catalog's own
 * edge selection. See `nearestCornerTo` for what this resolves to and why.
 */
export function tutorialSpawnAnchor(): TutorialSpawnAnchor | null {
  return governing ? spawnAnchor : null;
}
