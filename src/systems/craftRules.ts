import { CRAFT_PRODUCTION_BUILDING_KINDS } from "./constants.ts";
import type { CraftSpec } from "./craftCatalog.js";

export const CRAFT_PRODUCTION_BUILDINGS = new Set<string>(
  CRAFT_PRODUCTION_BUILDING_KINDS,
);

export interface CraftPurchaseOptions {
  spec: CraftSpec | undefined;
  crystals: number;
  buildingKind: string | null;
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

export function validateCraftPurchase({
  spec,
  crystals,
  buildingKind,
  tileAvailable,
}: CraftPurchaseOptions): CraftPurchaseValidation {
  if (!spec) return { ok: false, error: "Choose a craft" };
  if (spec.locked) return { ok: false, error: `${spec.label} is locked` };
  if (!buildingKind) return { ok: false, error: "Select a production building" };
  if (!CRAFT_PRODUCTION_BUILDINGS.has(buildingKind)) {
    return { ok: false, error: "That building cannot produce crafts" };
  }
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
