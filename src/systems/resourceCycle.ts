import { DIAGNOSTICS_ENABLED } from "./traceFlags.js";
import { gpuWarmupStatus } from "./gpuWarmup.js";
import { rendererTotals } from "./frameProfiler.js";
import { markAllocationResetBaseline } from "./traceRuntime.js";
import {
  resourceLifetimeDetails,
  resourceLifetimeSnapshot,
  type ResourceScope,
} from "./resourceLifetime.js";

/**
 * Reset-to-reset resource snapshots — the part that turns counters into an
 * answer.
 *
 * Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-03-Resource-Disposal-Tracking-Plan.md`,
 * section F.
 *
 * ## Why three snapshots and not one
 *
 * A single number after a restart cannot distinguish the three things a reader
 * needs to tell apart:
 *
 * - **`pre-reset`** — what the cycle grew to while it was played. The baseline
 *   for "did this cycle end heavier than the last one".
 * - **`post-teardown`** — taken after scenario objects are released and before
 *   anything is rebuilt. This is the only moment `scenario` and `temporary`
 *   outstanding are *supposed* to be zero, and the only place a leak can be
 *   attributed to teardown rather than to the rebuild.
 * - **`post-settled`** — the rebuilt scenario once pools have refilled and
 *   warm-up has drained. The cycle-to-cycle comparison point.
 *
 * Comparing `pre-reset` across cycles conflates a leak with a longer session.
 * Comparing `post-teardown` conflates it with a bigger rebuild. Only
 * `post-settled` against `post-settled` holds everything else equal.
 */

export type ResourcePhase = "pre-reset" | "post-teardown" | "post-settled";

/** Scopes that must be empty once teardown has run. */
const MUST_BE_ZERO: readonly ResourceScope[] = ["scenario", "temporary"];

let cycleId = 1;
let settledPending = false;
let settledWaitSeconds = 0;

/**
 * Seconds the rebuilt scenario must run before its settled snapshot.
 *
 * Pools refill lazily and GPU warm-up drains over several frames, so an
 * immediate reading would record a half-built cycle and report a plateau as
 * growth. Five seconds is the plan's figure and is comfortably past both.
 */
export const SETTLED_DELAY_SECONDS = 5;

/** The cycle a snapshot belongs to. Increments when a reset begins. */
export function currentResourceCycle(): number {
  return cycleId;
}

function scopeOutstanding(): Record<ResourceScope, number> {
  const snapshot = resourceLifetimeSnapshot();
  const read = (scope: ResourceScope): number =>
    snapshot.byScope.get(scope)?.outstanding ?? 0;
  return {
    scenario: read("scenario"),
    pool: read("pool"),
    session: read("session"),
    temporary: read("temporary"),
  };
}

/**
 * Emit one snapshot line, plus bounded detail when an expected-zero scope is not.
 *
 * The detail is the payoff: `scenarioOutstanding=3` says something leaked,
 * `label=health-bar-fill owner=Alien_7` says what and whose.
 */
export function emitResourceSnapshot(phase: ResourcePhase): void {
  if (!DIAGNOSTICS_ENABLED) return;
  const outstanding = scopeOutstanding();
  const renderer = rendererTotals();
  const warmup = gpuWarmupStatus();

  console.log(
    `[Resources] cycle=${cycleId} phase=${phase}` +
      ` scenarioOutstanding=${outstanding.scenario}` +
      ` temporaryOutstanding=${outstanding.temporary}` +
      ` poolOutstanding=${outstanding.pool}` +
      ` sessionOutstanding=${outstanding.session}` +
      ` rendererGeom=${renderer.geometries}` +
      ` rendererTex=${renderer.textures}` +
      ` rendererProg=${renderer.programs}` +
      ` rendererSampleAgeFrames=${renderer.sampleAgeFrames}` +
      ` warmQueued=${warmup.queued}` +
      ` warmActive=${warmup.active ? 1 : 0}`,
  );

  // Only after teardown is zero the expectation. At `pre-reset` a live scenario
  // legitimately holds hundreds of resources, and printing detail for all of
  // them would bury the one snapshot that matters.
  if (phase !== "post-teardown") return;
  const leaked = MUST_BE_ZERO.filter((scope) => outstanding[scope] > 0);
  if (leaked.length === 0) return;
  for (const line of resourceLifetimeDetails(leaked)) console.log(line);
}

/**
 * Open a new cycle. Called when a reset is about to tear the scenario down.
 *
 * Emits `pre-reset` first, because the increment must not be attributed to the
 * cycle that is ending — the line describes what the OLD cycle grew to.
 */
export function beginResourceCycle(): void {
  if (!DIAGNOSTICS_ENABLED) return;
  emitResourceSnapshot("pre-reset");
  cycleId += 1;
  settledPending = true;
  settledWaitSeconds = 0;
}

/**
 * Advance the deferred settled snapshot. Called once per profile flush.
 *
 * Four conditions, and all of them earn their place:
 *
 * - **a rebuilt scenario** (`matchReady`) — a snapshot taken while the match is
 *   still `restarting` measures a half-built board;
 * - **warm-up drained** — an active compile means pool materials are still
 *   being created, so the counts are mid-flight;
 * - **at least one render since the reset** — otherwise the renderer totals are
 *   from before the teardown and contradict the app counters beside them;
 * - **{@link SETTLED_DELAY_SECONDS}** — pools refill lazily, so an early
 *   reading reports a plateau as growth.
 *
 * @param deltaSeconds time since the previous flush.
 * @param matchReady false while the match is restarting.
 */
export function advanceSettledSnapshot(
  deltaSeconds: number,
  matchReady: boolean,
): void {
  if (!DIAGNOSTICS_ENABLED || !settledPending) return;
  if (!matchReady) return;

  const warmup = gpuWarmupStatus();
  if (warmup.active || warmup.queued > 0) return;
  if (rendererTotals().sampleAgeFrames > 1) return;

  settledWaitSeconds += deltaSeconds;
  if (settledWaitSeconds < SETTLED_DELAY_SECONDS) return;

  settledPending = false;
  emitResourceSnapshot("post-settled");
  // Section F: the allocation baseline is marked HERE and nowhere else. Marking
  // it at the reset would date it to a half-built scenario, so every
  // `since-reset` delta afterwards would count the rebuild as growth. This
  // function is the first moment the world is comparable to the last cycle's.
  markAllocationResetBaseline();
}

/** Test-only reset. The app never rewinds a cycle. */
export function resetResourceCycleForTest(): void {
  cycleId = 1;
  settledPending = false;
  settledWaitSeconds = 0;
}
