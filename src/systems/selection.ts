import {
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Entity,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE } from "./board.js";
import { TURRET_ATTACK_SPEC } from "./combatRules.js";
import {
  SELECTION_MARKER_COLOR,
  TURRET_RANGE_RING_COLOR,
  TURRET_RANGE_RING_THICKNESS,
} from "./constants.ts";
import { toggleSelectionMembership } from "./selectionRules.js";
import {
  BoardMarker,
  SelectionState,
  Unit,
  UnitSelection,
  boardState,
} from "./state.js";

export function getSelectedUnits(): Entity[] {
  return Array.from(boardState.selectedUnits).filter(
    (unit) =>
      unit.hasComponent(UnitSelection) &&
      (unit.getValue(UnitSelection, "selected") ?? false),
  );
}

export function getSingleSelectedUnit(): Entity | null {
  const selected = getSelectedUnits();
  return selected.length === 1 ? selected[0] : null;
}

export function toggleUnitSelection(world: World, unit: Entity): boolean {
  const selected = toggleSelectionMembership(boardState.selectedUnits, unit);
  unit.setValue(UnitSelection, "selected", selected);
  if (selected) boardState.selectedUnit = unit;
  else if (boardState.selectedUnit === unit) {
    const remaining = getSelectedUnits();
    boardState.selectedUnit = remaining[remaining.length - 1] ?? null;
  }
  setRingVisible(world, unit, selected);
  publishSelectionSummary();
  return selected;
}

export function clearUnitSelections(): void {
  for (const unit of boardState.selectedUnits) {
    unit.setValue(UnitSelection, "selected", false);
    const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
    if (ring) ring.visible = false;
  }
  boardState.selectedUnits.clear();
  boardState.selectedUnit = null;
  publishSelectionSummary();
}

export function removeUnitFromSelection(unit: Entity): void {
  if (!boardState.selectedUnits.delete(unit)) return;
  unit.setValue(UnitSelection, "selected", false);
  const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
  if (ring) ring.visible = false;
  if (boardState.selectedUnit === unit) {
    const remaining = getSelectedUnits();
    boardState.selectedUnit = remaining[remaining.length - 1] ?? null;
  }
  publishSelectionSummary();
}

export function updateUnitSelectionRing(unit: Entity): void {
  const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
  const object = unit.object3D;
  if (!ring || !object) return;
  ring.position.set(object.position.x, ring.position.y, object.position.z);
}

// Turrets aren't Units (no UnitSelection component), so this is a parallel
// single-selection toggle: clicking a turret shows a red ring at its
// attack range, clicking it again hides it, clicking a different turret
// swaps which one is shown.
export function toggleTurretRangeRing(world: World, turret: Entity): boolean {
  if (boardState.selectedTurret === turret) {
    hideTurretRangeRing(turret);
    boardState.selectedTurret = null;
    return false;
  }
  if (boardState.selectedTurret) {
    hideTurretRangeRing(boardState.selectedTurret);
  }
  boardState.selectedTurret = turret;
  showTurretRangeRing(world, turret);
  return true;
}

function hideTurretRangeRing(turret: Entity): void {
  const ring = boardState.rangeRingByTurret.get(turret.index)?.object3D;
  if (ring) ring.visible = false;
}

function showTurretRangeRing(world: World, turret: Entity): void {
  let ringEntity = boardState.rangeRingByTurret.get(turret.index);
  if (!ringEntity) {
    const root = boardState.boardRoot;
    if (!root) return;
    const range = TURRET_ATTACK_SPEC.range;
    const ring = new Mesh(
      new RingGeometry(range - TURRET_RANGE_RING_THICKNESS, range, 48),
      new MeshBasicMaterial({
        color: TURRET_RANGE_RING_COLOR,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );
    ring.name = `TurretRangeRing_${turret.index}`;
    ring.rotateX(-Math.PI / 2);
    ring.position.y = 0.026;
    const object = turret.object3D;
    if (object) ring.position.set(object.position.x, ring.position.y, object.position.z);
    ringEntity = world
      .createTransformEntity(ring, { parent: root })
      .addComponent(BoardMarker, { kind: "turret-range" });
    boardState.rangeRingByTurret.set(turret.index, ringEntity);
  }
  if (ringEntity.object3D) ringEntity.object3D.visible = true;
}

function setRingVisible(world: World, unit: Entity, visible: boolean): void {
  let ringEntity = boardState.selectionRingByUnit.get(unit.index);
  if (!ringEntity && visible) {
    const root = boardState.boardRoot;
    if (!root) return;
    const ring = new Mesh(
      new RingGeometry(TILE_SIZE * 0.4, TILE_SIZE * 0.53, 32),
      new MeshBasicMaterial({
        color: SELECTION_MARKER_COLOR,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    ring.name = `UnitSelectionRing_${unit.index}`;
    ring.rotateX(-Math.PI / 2);
    ring.position.y = 0.026;
    ringEntity = world
      .createTransformEntity(ring, { parent: root })
      .addComponent(BoardMarker, { kind: "unit-selection" });
    boardState.selectionRingByUnit.set(unit.index, ringEntity);
  }
  if (!ringEntity?.object3D) return;
  ringEntity.object3D.visible = visible;
  updateUnitSelectionRing(unit);
}

function publishSelectionSummary(): void {
  const selection = boardState.selection;
  if (!selection) return;
  const selected = getSelectedUnits();
  const primary = boardState.selectedUnit;
  selection.setValue(SelectionState, "unitIndex", primary?.index ?? -1);
  selection.setValue(
    SelectionState,
    "unitKind",
    selected.length > 1
      ? "group"
      : (primary?.getValue(Unit, "kind") ?? "none"),
  );
  selection.setValue(SelectionState, "selectedCount", selected.length);
  selection.setValue(
    SelectionState,
    "revision",
    (selection.getValue(SelectionState, "revision") ?? 0) + 1,
  );
}
