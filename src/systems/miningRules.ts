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
  | "deposited";

export interface MiningCycleState {
  stage: MiningStage;
  timer: number;
  cargo: number;
  nodeRemaining: number;
  amountPerTrip: number;
  gatherDuration: number;
  crystals: number;
}

// Mutates a caller-owned state object so the runtime system can reuse one
// scratch allocation across frames. Stockpile crystals change only here in the
// explicit deposit branch.
export function advanceMiningCycle(
  state: MiningCycleState,
  delta: number,
  arrived: boolean,
): MiningTransition {
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
