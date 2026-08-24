import type { GridPosition } from "./navigation.js";

export const INITIAL_WAVE_DELAY_SECONDS = 30;
export const ALIEN_MOVE_SPEED = 0.1;
export const ALIEN_ARRIVAL_EPSILON = 0.005;
export const ALIEN_REPATH_DELAY = 0.2;
export const ALIEN_MODEL_FORWARD_YAW = Math.PI;
export const ENEMY_MODEL_FORWARD_YAW: Readonly<Record<string, number>> = {
  alien: ALIEN_MODEL_FORWARD_YAW,
  alienDrake: ALIEN_MODEL_FORWARD_YAW,
  strongAlienMech: 0,
};

export type WaveStage = "countdown" | "active" | "stopped";
export type MatchStatus = "playing" | "defeat" | "victory" | "restarting";
export type WaveClearOutcome = "none" | "advance" | "victory";

export interface WaveClockState {
  stage: WaveStage;
  timer: number;
  waveNumber: number;
}

export interface LocalPosition {
  x: number;
  z: number;
}

export interface MovementStepResult {
  arrived: boolean;
  x: number;
  z: number;
}

export interface WaveReleaseConfig {
  maxActiveAliens: number;
  releaseIntervalSeconds: number;
}

export interface WaveReleaseState {
  releaseTimer: number;
  releasedAlienCount: number;
}

export interface WaveReleaseCounts {
  activeLiving: number;
  waitingReady: number;
}

export function alienFacingYaw(dx: number, dz: number): number {
  return Math.atan2(dx, dz) + ALIEN_MODEL_FORWARD_YAW;
}

export function enemyFacingYaw(kind: string, dx: number, dz: number): number {
  return Math.atan2(dx, dz) + (ENEMY_MODEL_FORWARD_YAW[kind] ?? ALIEN_MODEL_FORWARD_YAW);
}

export function advanceWaveClock(
  state: WaveClockState,
  delta: number,
  matchStatus: MatchStatus,
): boolean {
  if (matchStatus !== "playing") {
    state.stage = "stopped";
    state.timer = 0;
    return false;
  }
  if (state.stage !== "countdown") return false;
  state.timer = Math.max(0, state.timer - Math.max(0, delta));
  if (state.timer > 0) return false;
  state.stage = "active";
  return true;
}

export function advanceAlienMovement(
  position: LocalPosition,
  target: LocalPosition,
  speed: number,
  delta: number,
): MovementStepResult {
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance <= ALIEN_ARRIVAL_EPSILON) {
    return { arrived: true, x: target.x, z: target.z };
  }
  const step = Math.min(distance, Math.max(0, speed * delta));
  const x = position.x + (dx / distance) * step;
  const z = position.z + (dz / distance) * step;
  return {
    arrived: distance - step <= ALIEN_ARRIVAL_EPSILON,
    x: distance - step <= ALIEN_ARRIVAL_EPSILON ? target.x : x,
    z: distance - step <= ALIEN_ARRIVAL_EPSILON ? target.z : z,
  };
}

/**
 * Decide how many waiting reserves may enter play this tick.
 *
 * **`maxActiveAliens` is a cap, not a batch size.** Until 2026-08-23 the
 * timer-expiry path released a full batch without subtracting the aliens
 * already fighting, so Wave 6 could climb 8 -> 16 -> 24 -> 32 active while the
 * tablet still read "Max Active Aliens 8". Flagged as High #1 in
 * `devlog/2026-07-26-RTSVR-Code-Review.md` and as a "Known bug" in
 * `2026-07-25-Alien-Speed-Movement-And-Wave-Release-Timing.md`. Every return
 * below is now clamped by `capacity`, so the count can never exceed the cap.
 *
 * The two release paths that remain:
 *
 * - **Opening batch** — fills the cap immediately when the wave activates,
 *   without waiting for the timer.
 * - **Refill** — an active alien died, so one reserve enters at once rather
 *   than waiting out the interval. This is the "when an active alien dies, one
 *   waiting alien can enter early" rule from `Delay_attacking_straetgy.md`.
 *
 * Consequence worth knowing: because the refill is immediate, the active count
 * sits *at* the cap whenever reserves remain, so `releaseIntervalSeconds` no
 * longer paces a healthy wave — it only survives as the timer this function
 * keeps for the case where reserves are momentarily unavailable. Wave pacing is
 * now driven by the player's kill rate against the cap. If the interval should
 * gate refills too, that is a deliberate design change, not a bug fix.
 */
export function advanceWaveRelease(
  state: WaveReleaseState,
  counts: WaveReleaseCounts,
  config: WaveReleaseConfig,
  delta: number,
): number {
  if (counts.waitingReady <= 0) {
    state.releaseTimer = Math.max(0, config.releaseIntervalSeconds);
    return 0;
  }

  const cap = Math.max(1, Math.floor(config.maxActiveAliens));
  // Room left under the cap. Negative is possible if the cap was lowered mid-
  // wave from the Settings tab while more aliens were already fighting, so it
  // is clamped at 0 — that releases nothing until deaths bring the count back
  // under the new cap, rather than throwing or releasing a negative batch.
  const capacity = Math.max(0, cap - Math.max(0, counts.activeLiving));
  const offer = Math.min(capacity, counts.waitingReady);

  if (offer <= 0) {
    // At (or over) the cap. Hold the wave here and keep the interval ticking so
    // a later under-cap tick sees a sensible timer rather than a stale one.
    state.releaseTimer = Math.max(0, state.releaseTimer - Math.max(0, delta));
    return 0;
  }

  // Opening batch fills the cap; afterwards a death lets exactly one in early.
  const released = state.releasedAlienCount <= 0 ? offer : Math.min(1, offer);
  state.releasedAlienCount += released;
  state.releaseTimer = Math.max(0, config.releaseIntervalSeconds);
  return released;
}

export function isAdjacentToFootprint(
  point: GridPosition,
  anchor: GridPosition,
  widthTiles: number,
): boolean {
  const startX = anchor.x - Math.floor((widthTiles - 1) / 2);
  const startY = anchor.y - Math.floor((widthTiles - 1) / 2);
  const endX = startX + widthTiles - 1;
  const endY = startY + widthTiles - 1;
  const nearestX = Math.max(startX, Math.min(endX, point.x));
  const nearestY = Math.max(startY, Math.min(endY, point.y));
  return Math.abs(point.x - nearestX) + Math.abs(point.y - nearestY) === 1;
}

/**
 * Losing the command center ends the match, immediately and on its own.
 *
 * It did not, until 2026-08-19: `markCommandCenterDestroyed` flipped
 * `commandCenterAlive` but left `status` alone, and defeat only fired once
 * EVERY friendly was gone. So a player could lose their base and keep playing
 * with a lone astronaut — while the UI told them "COMMAND CENTER LOST" and the
 * tutorial's own opening line promised "lose it and the match ends".
 */
export function resolveMatchAfterCommandCenterLoss(
  current: MatchStatus,
): MatchStatus {
  if (current !== "playing") return current;
  return "defeat";
}

export function resolveMatchAfterFriendlyElimination(
  current: MatchStatus,
  remainingFriendlyTargets: number,
): MatchStatus {
  if (current !== "playing") return current;
  return remainingFriendlyTargets === 0 ? "defeat" : current;
}

export function resolveMatchAfterWaveCleared(
  current: MatchStatus,
  waveStage: WaveStage,
  remainingEnemies: number,
): MatchStatus {
  return resolveWaveClearOutcome(current, waveStage, remainingEnemies, false) ===
    "victory"
    ? "victory"
    : current;
}

export function resolveWaveClearOutcome(
  current: MatchStatus,
  waveStage: WaveStage,
  remainingEnemies: number,
  hasNextWave: boolean,
): WaveClearOutcome {
  if (current !== "playing" || waveStage !== "active" || remainingEnemies > 0) {
    return "none";
  }
  return hasNextWave ? "advance" : "victory";
}
