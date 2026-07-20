import type { BuildingSpec } from "./buildingCatalog.js";
import type { GridPosition } from "./navigation.js";

export type ConstructionStage = "idle" | "toSite" | "building";
export type ConstructionTransition =
  | "none"
  | "reachedSite"
  | "completed";

export interface ConstructionCycleState {
  stage: ConstructionStage;
  timer: number;
  duration: number;
}

export interface BuildValidationOptions {
  spec: BuildingSpec | undefined;
  crystals: number;
  builderIdle: boolean;
  footprintValid: boolean;
  pathFound: boolean;
}

export type BuildValidation =
  | { ok: true; remainingCrystals: number }
  | { ok: false; error: string };

export function footprintCells(
  anchorX: number,
  anchorY: number,
  widthTiles: number,
): GridPosition[] {
  const startX = anchorX - Math.floor((widthTiles - 1) / 2);
  const startY = anchorY - Math.floor((widthTiles - 1) / 2);
  const cells: GridPosition[] = [];
  for (let y = startY; y < startY + widthTiles; y += 1) {
    for (let x = startX; x < startX + widthTiles; x += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

export function footprintApproaches(
  anchorX: number,
  anchorY: number,
  widthTiles: number,
  gridSize: number,
): GridPosition[] {
  const cells = footprintCells(anchorX, anchorY, widthTiles);
  const occupied = new Set(cells.map(({ x, y }) => `${x},${y}`));
  const approaches = new Map<string, GridPosition>();
  for (const cell of cells) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      const key = `${x},${y}`;
      if (
        x >= 0 &&
        y >= 0 &&
        x < gridSize &&
        y < gridSize &&
        !occupied.has(key)
      ) {
        approaches.set(key, { x, y });
      }
    }
  }
  return [...approaches.values()];
}

export function validateBuildOrder({
  spec,
  crystals,
  builderIdle,
  footprintValid,
  pathFound,
}: BuildValidationOptions): BuildValidation {
  if (!spec) return { ok: false, error: "Choose a building" };
  if (spec.locked) return { ok: false, error: `${spec.label} is locked` };
  if (!builderIdle) return { ok: false, error: "Astronaut is already building" };
  if (!footprintValid) return { ok: false, error: "That footprint is blocked" };
  if (!pathFound) return { ok: false, error: "No path to that site" };
  if (crystals < spec.cost) {
    return { ok: false, error: `Need ${spec.cost} crystals` };
  }
  return { ok: true, remainingCrystals: crystals - spec.cost };
}

export function advanceConstruction(
  state: ConstructionCycleState,
  delta: number,
  arrived: boolean,
): ConstructionTransition {
  if (state.stage === "toSite" && arrived) {
    state.stage = "building";
    state.timer = 0;
    return "reachedSite";
  }
  if (state.stage !== "building") return "none";

  state.timer = Math.min(state.duration, state.timer + delta);
  if (state.timer < state.duration) return "none";
  state.stage = "idle";
  return "completed";
}

export function constructionProgress(timer: number, duration: number): number {
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, timer / duration));
}
