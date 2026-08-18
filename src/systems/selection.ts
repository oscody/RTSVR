import {
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Entity,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE } from "./board.js";
import { makeNonInteractive } from "./sharedGeometry.js";
import {
  getEnemyAttackSpec,
  getUnitAttackSpec,
  TURRET_ATTACK_SPEC,
} from "./combatRules.js";
import {
  ATTACK_RANGE_RING_COLOR,
  ATTACK_RANGE_RING_OPACITY,
  ATTACK_RANGE_RING_SEGMENTS,
  ATTACK_RANGE_RING_THICKNESS,
  ATTACK_RANGE_RING_Y_OFFSET,
  ENEMY_RANGE_RING_COLOR,
  SELECTION_MARKER_COLOR,
} from "./constants.ts";
import { toggleSelectionMembership } from "./selectionRules.js";
import {
  BoardMarker,
  DebugSettings,
  Enemy,
  SelectionState,
  TabletState,
  Unit,
  UnitSelection,
  boardState,
} from "./state.js";

function currentTurretRange(): number {
  return (
    boardState.debugSettings?.getValue(DebugSettings, "turretRange") ??
    TURRET_ATTACK_SPEC.range
  );
}

function currentUnitAttackRange(kind: string): number | null {
  const spec = getUnitAttackSpec(kind);
  if (!spec) return null;
  if (kind === "astronaut") {
    return (
      boardState.debugSettings?.getValue(
        DebugSettings,
        "astronautAttackRange",
      ) ?? spec.range
    );
  }
  if (kind === "racer") {
    return (
      boardState.debugSettings?.getValue(
        DebugSettings,
        "craftRacerAttackRange",
      ) ?? spec.range
    );
  }
  return spec.range;
}

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
  // Selecting your own unit ends enemy-inspection mode: from here a click on an
  // alien means "attack that", so leaving its threat ring up would be confusing.
  clearEnemyRangeRing();
  const selected = toggleSelectionMembership(boardState.selectedUnits, unit);
  unit.setValue(UnitSelection, "selected", selected);
  if (selected) boardState.selectedUnit = unit;
  else if (boardState.selectedUnit === unit) {
    const remaining = getSelectedUnits();
    boardState.selectedUnit = remaining[remaining.length - 1] ?? null;
  }
  setRingVisible(world, unit, selected);
  setUnitAttackRangeRingVisible(world, unit, selected);
  publishSelectionSummary();
  return selected;
}

export function clearUnitSelections(): void {
  for (const unit of boardState.selectedUnits) {
    unit.setValue(UnitSelection, "selected", false);
    const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
    if (ring) ring.visible = false;
    const rangeRing = boardState.attackRangeRingByUnit.get(unit.index)?.object3D;
    if (rangeRing) rangeRing.visible = false;
  }
  boardState.selectedUnits.clear();
  boardState.selectedUnit = null;
  publishSelectionSummary();
}

export function updateCommandGridVisibility(): void {
  const grid = boardState.gridOverlay?.object3D;
  if (!grid) return;
  const tablet = boardState.tablet;
  const placementActive = Boolean(
    tablet &&
      ((tablet.getValue(TabletState, "buildPlacementActive") ?? false) ||
        (tablet.getValue(TabletState, "craftPlacementActive") ?? false)),
  );
  grid.visible =
    boardState.selectedUnits.size > 0 ||
    Boolean(boardState.selectedTurret) ||
    placementActive;
}

export function removeUnitFromSelection(unit: Entity): void {
  if (!boardState.selectedUnits.delete(unit)) return;
  unit.setValue(UnitSelection, "selected", false);
  const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
  if (ring) ring.visible = false;
  const rangeRing = boardState.attackRangeRingByUnit.get(unit.index)?.object3D;
  if (rangeRing) rangeRing.visible = false;
  if (boardState.selectedUnit === unit) {
    const remaining = getSelectedUnits();
    boardState.selectedUnit = remaining[remaining.length - 1] ?? null;
  }
  publishSelectionSummary();
}

// Deselecting only HIDES a unit's rings, because a live unit will very likely
// be selected again and rebuilding the geometry each time is wasteful. Death or
// deliberate destruction is different: the rings are garbage, and EliCS
// **recycles entity indices** (`EntityManager.requestEntityInstance` pops from a
// pool and keeps `index`, bumping only `generation`). These maps are keyed on
// the raw index, so leaving an entry behind means the next unit to land on that
// index inherits a dead unit's ring — including its baked attack-range radius,
// which is per-kind and live-tunable. Same reason `cargoVisualByUnit` and
// `pathByUnit` are deleted on death.
export function disposeUnitSelectionVisuals(unit: Entity): void {
  const ring = boardState.selectionRingByUnit.get(unit.index);
  if (ring) {
    ring.dispose();
    boardState.selectionRingByUnit.delete(unit.index);
  }
  const rangeRing = boardState.attackRangeRingByUnit.get(unit.index);
  if (rangeRing) {
    rangeRing.dispose();
    boardState.attackRangeRingByUnit.delete(unit.index);
  }
}

// Turrets keep their range ring in a parallel map and are not Units, so they
// need their own disposal — and `selectedTurret` must be cleared or it holds a
// disposed entity.
export function disposeTurretRangeRing(turret: Entity): void {
  if (boardState.selectedTurret === turret) {
    boardState.selectedTurret = null;
    updateCommandGridVisibility();
  }
  const ring = boardState.rangeRingByTurret.get(turret.index);
  if (!ring) return;
  ring.dispose();
  boardState.rangeRingByTurret.delete(turret.index);
}

export function updateUnitSelectionRing(unit: Entity): void {
  const ring = boardState.selectionRingByUnit.get(unit.index)?.object3D;
  const object = unit.object3D;
  if (!ring || !object) return;
  ring.position.set(object.position.x, ring.position.y, object.position.z);
}

export function updateUnitAttackRangeRing(unit: Entity): void {
  const ring = boardState.attackRangeRingByUnit.get(unit.index)?.object3D;
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
    updateCommandGridVisibility();
    return false;
  }
  if (boardState.selectedTurret) {
    hideTurretRangeRing(boardState.selectedTurret);
  }
  boardState.selectedTurret = turret;
  showTurretRangeRing(world, turret);
  updateCommandGridVisibility();
  return true;
}

/**
 * Show an alien's threat radius on click — how close it has to get before it
 * can hit something.
 *
 * Only reachable with no friendly unit selected. With units selected, a click
 * on an alien already means "attack that", and inspection must not hijack an
 * order (see the `units.length === 0` branch in `interaction.ts`).
 */
export function toggleEnemyRangeRing(world: World, enemy: Entity): boolean {
  if (boardState.selectedEnemy === enemy) {
    hideEnemyRangeRing(enemy);
    boardState.selectedEnemy = null;
    return false;
  }
  if (boardState.selectedEnemy) hideEnemyRangeRing(boardState.selectedEnemy);
  boardState.selectedEnemy = enemy;
  showEnemyRangeRing(world, enemy);
  return true;
}

function hideEnemyRangeRing(enemy: Entity): void {
  const ring = boardState.rangeRingByEnemy.get(enemy.index)?.object3D;
  if (ring) ring.visible = false;
}

function showEnemyRangeRing(world: World, enemy: Entity): void {
  let ringEntity = boardState.rangeRingByEnemy.get(enemy.index);
  if (!ringEntity) {
    const root = boardState.boardRoot;
    if (!root) return;
    const range = getEnemyAttackSpec(enemy.getValue(Enemy, "kind") ?? "alien")
      .range;
    const ring = new Mesh(
      new RingGeometry(
        Math.max(ATTACK_RANGE_RING_THICKNESS, range - ATTACK_RANGE_RING_THICKNESS),
        range,
        ATTACK_RANGE_RING_SEGMENTS,
      ),
      new MeshBasicMaterial({
        // Purple, not the friendly red: this is a threat radius, not one of
        // your own weapons. Same hue the alien melee bursts already use.
        color: ENEMY_RANGE_RING_COLOR,
        transparent: true,
        opacity: ATTACK_RANGE_RING_OPACITY,
        depthWrite: false,
      }),
    );
    makeNonInteractive(ring);
    ring.name = `EnemyRangeRing_${enemy.index}`;
    ring.rotateX(-Math.PI / 2);
    ring.position.y = ATTACK_RANGE_RING_Y_OFFSET;
    ringEntity = world
      .createTransformEntity(ring, { parent: root })
      .addComponent(BoardMarker, { kind: "enemy-range" });
    boardState.rangeRingByEnemy.set(enemy.index, ringEntity);
  }
  const object = ringEntity.object3D;
  if (!object) return;
  object.visible = true;
  // Aliens walk, so the ring is re-seated on every show and then tracked each
  // frame by EnemyRangeRingSystem while it stays visible.
  syncEnemyRangeRing(enemy, ringEntity);
}

function syncEnemyRangeRing(enemy: Entity, ringEntity: Entity): void {
  const source = enemy.object3D;
  const ring = ringEntity.object3D;
  if (!source || !ring) return;
  ring.position.set(source.position.x, ATTACK_RANGE_RING_Y_OFFSET, source.position.z);
}

/** Keep the visible ring under its alien as it advances. */
export function updateEnemyRangeRing(): void {
  const enemy = boardState.selectedEnemy;
  if (!enemy) return;
  const ringEntity = boardState.rangeRingByEnemy.get(enemy.index);
  if (!ringEntity?.object3D?.visible) return;
  syncEnemyRangeRing(enemy, ringEntity);
}

/**
 * Entity indexes are recycled, so a ring left keyed to a dead alien would
 * reappear under whatever entity claims that index next. Called on enemy death
 * and on scenario reset.
 */
export function disposeEnemyRangeRing(enemy: Entity): void {
  if (boardState.selectedEnemy === enemy) boardState.selectedEnemy = null;
  const ring = boardState.rangeRingByEnemy.get(enemy.index);
  if (!ring) return;
  ring.dispose();
  boardState.rangeRingByEnemy.delete(enemy.index);
}

export function clearEnemyRangeRing(): void {
  const enemy = boardState.selectedEnemy;
  if (enemy) hideEnemyRangeRing(enemy);
  boardState.selectedEnemy = null;
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
    const range = currentTurretRange();
    const ring = new Mesh(
      new RingGeometry(
        range - ATTACK_RANGE_RING_THICKNESS,
        range,
        ATTACK_RANGE_RING_SEGMENTS,
      ),
      new MeshBasicMaterial({
        color: ATTACK_RANGE_RING_COLOR,
        transparent: true,
        opacity: ATTACK_RANGE_RING_OPACITY,
        depthWrite: false,
      }),
    );
    makeNonInteractive(ring);
    ring.name = `TurretRangeRing_${turret.index}`;
    ring.rotateX(-Math.PI / 2);
    ring.position.y = ATTACK_RANGE_RING_Y_OFFSET;
    const object = turret.object3D;
    if (object) ring.position.set(object.position.x, ring.position.y, object.position.z);
    ringEntity = world
      .createTransformEntity(ring, { parent: root })
      .addComponent(BoardMarker, { kind: "turret-range" });
    boardState.rangeRingByTurret.set(turret.index, ringEntity);
  }
  if (ringEntity.object3D) ringEntity.object3D.visible = true;
}

// Called from the tablet's Settings tab when the turret-range debug value
// changes, so an already-visible range ring reflects the new radius
// immediately instead of only on next select/deselect.
export function refreshTurretRangeRingGeometry(): void {
  const turret = boardState.selectedTurret;
  if (!turret) return;
  const ringEntity = boardState.rangeRingByTurret.get(turret.index);
  const mesh = ringEntity?.object3D as Mesh | undefined;
  if (!mesh) return;
  const range = currentTurretRange();
  mesh.geometry.dispose();
  mesh.geometry = new RingGeometry(
    range - ATTACK_RANGE_RING_THICKNESS,
    range,
    ATTACK_RANGE_RING_SEGMENTS,
  );
}

export function refreshUnitAttackRangeRingGeometry(): void {
  for (const unit of boardState.selectedUnits) {
    const kind = unit.getValue(Unit, "kind") ?? "";
    const range = currentUnitAttackRange(kind);
    if (range === null) continue;
    const ringEntity = boardState.attackRangeRingByUnit.get(unit.index);
    const mesh = ringEntity?.object3D as Mesh | undefined;
    if (!mesh) continue;
    mesh.geometry.dispose();
    mesh.geometry = new RingGeometry(
      range - ATTACK_RANGE_RING_THICKNESS,
      range,
      ATTACK_RANGE_RING_SEGMENTS,
    );
  }
}

function setUnitAttackRangeRingVisible(
  world: World,
  unit: Entity,
  visible: boolean,
): void {
  const range = currentUnitAttackRange(unit.getValue(Unit, "kind") ?? "");
  if (range === null) {
    const ring = boardState.attackRangeRingByUnit.get(unit.index)?.object3D;
    if (ring) ring.visible = false;
    return;
  }

  let ringEntity = boardState.attackRangeRingByUnit.get(unit.index);
  if (!ringEntity && visible) {
    const root = boardState.boardRoot;
    if (!root) return;
    const ring = new Mesh(
      new RingGeometry(
        range - ATTACK_RANGE_RING_THICKNESS,
        range,
        ATTACK_RANGE_RING_SEGMENTS,
      ),
      new MeshBasicMaterial({
        color: ATTACK_RANGE_RING_COLOR,
        transparent: true,
        opacity: ATTACK_RANGE_RING_OPACITY,
        depthWrite: false,
      }),
    );
    makeNonInteractive(ring);
    ring.name = `UnitAttackRangeRing_${unit.index}`;
    ring.rotateX(-Math.PI / 2);
    ring.position.y = ATTACK_RANGE_RING_Y_OFFSET;
    ringEntity = world
      .createTransformEntity(ring, { parent: root })
      .addComponent(BoardMarker, { kind: "unit-attack-range" });
    boardState.attackRangeRingByUnit.set(unit.index, ringEntity);
  }
  if (!ringEntity?.object3D) return;
  ringEntity.object3D.visible = visible;
  updateUnitAttackRangeRing(unit);
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
    makeNonInteractive(ring);
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
  // Command grid is visible whenever the player is choosing a board tile or
  // has a commandable/range-readable entity selected.
  updateCommandGridVisibility();
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
