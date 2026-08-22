import { type Entity } from "@iwsdk/core";
import { getBuildingSpec } from "./buildingCatalog.js";
import { getProductionSpec } from "./craftCatalog.js";
import {
  cancelConstructionSite,
  grantCrystals,
  releaseBuilder,
  releaseSiteBuilders,
} from "./construction.js";
import { destroyRefund, footprintCells } from "./constructionRules.js";
import { detachCommandCenterAnimation } from "./commandCenterAnimation.js";
import { detachCraftProductionAnimation } from "./craftProductionAnimation.js";
import { detachMinerAnimation } from "./minerAnimation.js";
import { detachTurretAnimation } from "./turretAnimation.js";
import { detachUnitAnimation } from "./unitAnimation.js";
import { releaseEntity } from "./entityTeardown.js";
import {
  disposeTurretRangeRing,
  disposeUnitSelectionVisuals,
  removeUnitFromSelection,
} from "./selection.js";
import {
  Building,
  ConstructionSite,
  ConstructionState,
  CraftProductionSite,
  MinerState,
  Unit,
  boardState,
  setTerrainAt,
} from "./state.js";

export interface DemolitionResult {
  ok: boolean;
  refund: number;
  label: string;
  reason?: string;
}

// What deliberately scrapping this thing gives back. Buildings and units read
// their own catalog cost; anything without a catalog entry refunds nothing
// rather than guessing.
function unitRefundCost(kind: string): number {
  return getProductionSpec(kind)?.cost ?? 0;
}

function buildingRefundCost(kind: string): number {
  return getBuildingSpec(kind)?.cost ?? 0;
}

export function canDestroy(entity: Entity): DemolitionResult | null {
  if (
    entity.hasComponent(Building) &&
    entity.getValue(Building, "kind") === "command-center"
  ) {
    return {
      ok: false,
      refund: 0,
      label: "Command Center",
      // The command center is the defeat condition. Refusing loudly beats
      // silently doing nothing when the player clicks Destroy on it.
      reason: "The command center cannot be destroyed",
    };
  }
  return null;
}

// Destroys one friendly thing on purpose and returns part of what it cost.
// Cancelling an unbuilt order is a different, fuller refund — see
// cancelConstructionSite.
export function destroyOwnEntity(entity: Entity): DemolitionResult {
  const refusal = canDestroy(entity);
  if (refusal) return refusal;

  if (entity.hasComponent(ConstructionSite)) {
    const label =
      getBuildingSpec(entity.getValue(ConstructionSite, "kind") ?? "")?.label ??
      "Site";
    return { ok: true, refund: cancelConstructionSite(entity), label };
  }

  if (entity.hasComponent(CraftProductionSite)) {
    return destroyCraftProductionSite(entity);
  }

  if (entity.hasComponent(Unit)) return destroyUnit(entity);
  if (entity.hasComponent(Building)) return destroyBuilding(entity);
  return { ok: false, refund: 0, label: "Unknown", reason: "Nothing to destroy" };
}

function destroyUnit(unit: Entity): DemolitionResult {
  const kind = unit.getValue(Unit, "kind") ?? "unit";
  const label = getProductionSpec(kind)?.label ?? kind;
  const refund = destroyRefund(unitRefundCost(kind));
  // An astronaut mid-build must let go of its site first, or the site keeps a
  // dead builder in its count and its beacon role.
  if (unit.hasComponent(ConstructionState)) releaseBuilder(unit);
  if (unit.hasComponent(MinerState)) {
    unit.setValue(MinerState, "stage", "idle");
    unit.setValue(MinerState, "target", null);
  }
  detachMinerAnimation(unit);
  detachUnitAnimation(unit);
  removeUnitFromSelection(unit);
  disposeUnitSelectionVisuals(unit);
  boardState.cargoVisualByUnit.delete(unit.index);
  boardState.pathByUnit.delete(unit.index);
  disposeEntity(unit);
  grantCrystals(refund);
  return { ok: true, refund, label };
}

function destroyBuilding(building: Entity): DemolitionResult {
  const kind = building.getValue(Building, "kind") ?? "building";
  const label = getBuildingSpec(kind)?.label ?? kind;
  const refund = destroyRefund(buildingRefundCost(kind));
  const x = building.getValue(Building, "x") ?? -1;
  const y = building.getValue(Building, "y") ?? -1;
  const width = building.getValue(Building, "widthTiles") ?? 1;
  // Free the ground it was standing on, same release path cancel uses.
  for (const cell of footprintCells(x, y, width)) {
    setTerrainAt(cell.x, cell.y, "open");
  }
  if (kind === "turret") {
    detachTurretAnimation(building);
    disposeTurretRangeRing(building);
  }
  if (kind === "command-center") detachCommandCenterAnimation(building);
  disposeEntity(building);
  grantCrystals(refund);
  return { ok: true, refund, label };
}

// Craft under construction. Its crystals were taken when it was placed and no
// craft exists yet, so this is a cancel: full refund, tile released.
function destroyCraftProductionSite(site: Entity): DemolitionResult {
  const kind = site.getValue(CraftProductionSite, "kind") ?? "craft";
  const spec = getProductionSpec(kind);
  const label = spec?.label ?? kind;
  const x = site.getValue(CraftProductionSite, "x") ?? -1;
  const y = site.getValue(CraftProductionSite, "y") ?? -1;
  setTerrainAt(x, y, "open");
  detachCraftProductionAnimation(site);
  releaseSiteBuilders(site);
  boardState.buildersBySite.delete(site.index);
  disposeEntity(site);
  grantCrystals(spec?.cost ?? 0);
  return { ok: true, refund: spec?.cost ?? 0, label };
}

function disposeEntity(entity: Entity): void {
  // Mirrors CombatSystem's destroy path: drop the ray target, then tear the
  // entity down WITHOUT traverse-disposing GLTF resources shared with every
  // other clone of the same asset. Both are `releaseEntity`'s job.
  releaseEntity(entity);
}
