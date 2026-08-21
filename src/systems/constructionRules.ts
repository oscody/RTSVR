import type { BuildingSpec } from "./buildingCatalog.js";
import {
  BUILD_RATE_MAX_MULTIPLIER,
  BUILD_RATE_PER_EXTRA_BUILDER,
  CANCEL_REFUND_RATE,
  DESTROY_REFUND_RATE,
} from "./constants.ts";
import type { GridPosition } from "./navigation.js";

// The builder's own stage is now purely a role: is it walking to a site, is it
// working on one, or is it free. The timer that decides when the building
// finishes lives on the SITE (see SiteCycleState) so that any number of
// astronauts can contribute to it and it can only complete once.
export type ConstructionStage = "idle" | "toSite" | "building";
export type ConstructionTransition = "none" | "completed";

// A site is "pending" until at least one builder has arrived, then "building",
// then "done". "done" is a latch: it is what makes a second completion
// impossible even if the site is advanced again before it is disposed.
export type SiteStage = "pending" | "building" | "done";

export interface SiteCycleState {
  stage: SiteStage;
  timer: number;
  duration: number;
}

export interface BuildValidationOptions {
  spec: BuildingSpec | undefined;
  crystals: number;
  // Place-first construction does not require a builder, so this defaults to
  // true. It is still honoured by the direct-assignment path.
  builderIdle?: boolean;
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
  builderIdle = true,
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

// How fast a site fills with `builderCount` astronauts working on it.
// Diminishing returns with a hard cap — see the constants for why.
export function buildRateMultiplier(builderCount: number): number {
  if (builderCount <= 0) return 0;
  return Math.min(
    BUILD_RATE_MAX_MULTIPLIER,
    1 + BUILD_RATE_PER_EXTRA_BUILDER * (builderCount - 1),
  );
}

// Advances the SITE, not a builder. Called once per site per frame, so a
// building can only ever complete once no matter how many astronauts are
// attached to it — the duplicate-building bug is structurally impossible here.
export function advanceSiteConstruction(
  state: SiteCycleState,
  delta: number,
  builderCount: number,
): ConstructionTransition {
  if (state.stage === "done") return "none";
  if (builderCount <= 0) {
    state.stage = state.timer > 0 ? "building" : "pending";
    return "none";
  }
  state.stage = "building";
  state.timer = Math.min(
    state.duration,
    state.timer + delta * buildRateMultiplier(builderCount),
  );
  if (state.timer < state.duration) return "none";
  state.stage = "done";
  return "completed";
}

export function constructionProgress(timer: number, duration: number): number {
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, timer / duration));
}

export interface QueuedBuild {
  queueOrder: number;
  inProgress: boolean;
}

// Which queued build the tablet's Cancel acts on: the one being worked on, and
// if nothing has been started, the first in the queue. With several under way
// the earliest-queued wins, so repeated presses unwind from the front — which
// is what the numbers floating over the board promise.
export function pickCancelTarget<T extends QueuedBuild>(
  builds: readonly T[],
): T | null {
  let working: T | null = null;
  let waiting: T | null = null;
  for (const build of builds) {
    if (build.inProgress) {
      if (!working || build.queueOrder < working.queueOrder) working = build;
    } else if (!waiting || build.queueOrder < waiting.queueOrder) {
      waiting = build;
    }
  }
  return working ?? waiting;
}

// Display position among the builds still WAITING. A build with someone on it
// loses its number (its progress bar takes over) and the rest renumber from 1.
export function queueDisplayPositions<T extends QueuedBuild>(
  builds: readonly T[],
): Map<T, number> {
  const waiting = builds
    .filter((build) => !build.inProgress)
    .sort((a, b) => a.queueOrder - b.queueOrder);
  const positions = new Map<T, number>();
  waiting.forEach((build, index) => positions.set(build, index + 1));
  return positions;
}

export function cancelRefund(cost: number): number {
  return Math.max(0, Math.round(cost * CANCEL_REFUND_RATE));
}

export function destroyRefund(cost: number): number {
  return Math.max(0, Math.round(cost * DESTROY_REFUND_RATE));
}

/**
 * Of the sites queued for completion, which are still safe to complete?
 *
 * Completion is **deferred**: a site that finishes is pushed onto a queue and
 * disposed in a second pass, because disposing while iterating the query it came
 * from is not safe. That gap is real — a cancel, a demolition, a scenario reset,
 * or a cascade out of an earlier completion in the same drain can dispose a site
 * that is already queued.
 *
 * Completing a dead handle is not merely a duplicate warning. Entity indices are
 * **pooled and reused**, and completion deletes from a map keyed on
 * `entity.index` — so a recycled index means deleting a *live* site's builder
 * list. The console showed three of these in one 236-second run.
 *
 * Pure and index-agnostic so it can be tested without an ECS: it only asks
 * whether each queued item still reports itself active.
 */
export function completableSites<T extends { active: boolean }>(
  queued: readonly T[],
): T[] {
  return queued.filter((site) => site.active);
}
