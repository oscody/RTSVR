import { CRAFT_PRODUCTION_BUILDING_KINDS } from "./constants.ts";
import type { CraftSpec } from "./craftCatalog.js";

export const CRAFT_PRODUCTION_BUILDINGS = new Set<string>(
  CRAFT_PRODUCTION_BUILDING_KINDS,
);

export interface CraftPurchaseOptions {
  spec: CraftSpec | undefined;
  crystals: number;
  tileAvailable: boolean;
}

export type CraftPurchaseValidation =
  | { ok: true; remainingCrystals: number }
  | { ok: false; error: string };

export interface CraftProductionCycleState {
  timer: number;
  duration: number;
}

export type CraftProductionTransition = "none" | "completed";

// Place-first, and no producer requirement (decided 2026-08-09): you never
// select a building to produce from, and you do not need one to exist. Pick a
// craft, pick a tile. `CRAFT_PRODUCTION_BUILDINGS` is kept because the vision
// doc still wants "units locked behind buildings" later — it is simply not
// consulted here any more.
export function validateCraftPurchase({
  spec,
  crystals,
  tileAvailable,
}: CraftPurchaseOptions): CraftPurchaseValidation {
  if (!spec) return { ok: false, error: "Choose a craft" };
  if (spec.locked) return { ok: false, error: `${spec.label} is locked` };
  if (!tileAvailable) return { ok: false, error: "That tile is blocked" };
  if (crystals < spec.cost) {
    return { ok: false, error: `Need ${spec.cost} crystals` };
  }
  return { ok: true, remainingCrystals: crystals - spec.cost };
}

export function advanceCraftProduction(
  state: CraftProductionCycleState,
  delta: number,
): CraftProductionTransition {
  if (state.timer >= state.duration) return "none";
  state.timer = Math.min(state.duration, state.timer + delta);
  return state.timer >= state.duration ? "completed" : "none";
}

export function craftProductionProgress(
  timer: number,
  duration: number,
): number {
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, timer / duration));
}
