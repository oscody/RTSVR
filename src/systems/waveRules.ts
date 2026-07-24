import type { GridPosition } from "./navigation.js";

export const INITIAL_WAVE_DELAY_SECONDS = 1;
export const ALIEN_MOVE_SPEED = 0.18;
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

  const batchSize = Math.max(1, Math.floor(config.maxActiveAliens));
  if (state.releasedAlienCount <= 0) {
    const released = Math.min(batchSize, counts.waitingReady);
    state.releasedAlienCount += released;
    state.releaseTimer = Math.max(0, config.releaseIntervalSeconds);
    return released;
  }

  if (counts.activeLiving < batchSize) {
    state.releasedAlienCount += 1;
    state.releaseTimer = Math.max(0, config.releaseIntervalSeconds);
    return 1;
  }

  state.releaseTimer = Math.max(
    0,
    state.releaseTimer - Math.max(0, delta),
  );
  if (state.releaseTimer > 0) return 0;

  const released = Math.min(batchSize, counts.waitingReady);
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
