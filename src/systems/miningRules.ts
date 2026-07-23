export type MiningStage =
  | "idle"
  | "toResource"
  | "gathering"
  | "toBase"
  | "deposit";

export type MiningTransition =
  | "none"
  | "startedGathering"
  | "loadedCargo"
  | "resourceEmpty"
  | "reachedBase"
  | "deposited"
  | "baseUnavailable";

export interface MiningCycleState {
  stage: MiningStage;
  timer: number;
  cargo: number;
  nodeRemaining: number;
  amountPerTrip: number;
  gatherDuration: number;
  crystals: number;
}

export interface MiningGridPosition {
  x: number;
  y: number;
}

export interface MiningTargetCandidate<T> extends MiningGridPosition {
  target: T;
  remaining: number;
}

export interface MiningTargetSelection<T> extends MiningGridPosition {
  target: T;
  approach: MiningGridPosition;
}

export function selectNearestMiningTarget<T>(
  from: MiningGridPosition,
  candidates: readonly MiningTargetCandidate<T>[],
  findApproach: (
    candidate: MiningTargetCandidate<T>,
  ) => MiningGridPosition | null,
): MiningTargetSelection<T> | null {
  let best: MiningTargetSelection<T> | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (candidate.remaining <= 0) continue;
    const approach = findApproach(candidate);
    if (!approach) continue;
    const distance =
      (approach.x - from.x) ** 2 + (approach.y - from.y) ** 2;
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        (!best ||
          candidate.y < best.y ||
          (candidate.y === best.y && candidate.x < best.x)))
    ) {
      bestDistance = distance;
      best = {
        target: candidate.target,
        x: candidate.x,
        y: candidate.y,
        approach,
      };
    }
  }

  return best;
}

// Mutates a caller-owned state object so the runtime system can reuse one
// scratch allocation across frames. Stockpile crystals change only here in the
// explicit deposit branch.
export function advanceMiningCycle(
  state: MiningCycleState,
  delta: number,
  arrived: boolean,
  baseAvailable = true,
): MiningTransition {
  if (!baseAvailable && state.stage !== "idle") {
    state.stage = "idle";
    state.timer = 0;
    state.cargo = 0;
    return "baseUnavailable";
  }

  if (state.stage === "toResource" && arrived) {
    state.stage = "gathering";
    state.timer = 0;
    return "startedGathering";
  }

  if (state.stage === "gathering") {
    state.timer += delta;
    if (state.timer < state.gatherDuration) return "none";
    state.timer = 0;
    if (state.nodeRemaining <= 0) {
      state.stage = "idle";
      return "resourceEmpty";
    }
    const loaded = Math.min(state.amountPerTrip, state.nodeRemaining);
    state.nodeRemaining -= loaded;
    state.cargo += loaded;
    state.stage = "toBase";
    return "loadedCargo";
  }

  if (state.stage === "toBase" && arrived) {
    state.stage = "deposit";
    state.timer = 0;
    return "reachedBase";
  }

  if (state.stage === "deposit") {
    state.crystals += state.cargo;
    state.cargo = 0;
    state.stage = state.nodeRemaining > 0 ? "toResource" : "idle";
    return "deposited";
  }

  return "none";
}
