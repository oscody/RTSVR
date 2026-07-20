import {
  Entity,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  Pressed,
  createSystem,
} from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import { findApproachTile } from "./navigation.js";
import {
  BoardTile,
  Enemy,
  SelectionState,
  Unit,
  boardState,
  gridKey,
} from "./state.js";

const ORDER_COLOR = 0xffbd59; // valid destination
const BLOCKED_COLOR = 0xff5050; // clicked a blocked/occupied tile

function markerToLocal(markerEntity: Entity | null, x: number, z: number): void {
  const marker = markerEntity?.object3D;
  if (!marker) return;
  marker.position.set(x, marker.position.y, z);
  marker.visible = true;
}

function hideMarker(markerEntity: Entity | null): void {
  const marker = markerEntity?.object3D;
  if (marker) marker.visible = false;
}

function moveMarker(markerEntity: Entity | null, tile: Entity | null): void {
  if (!tile) {
    hideMarker(markerEntity);
    return;
  }
  const [worldX, worldZ] = gridToWorld(
    tile.getValue(BoardTile, "x") ?? 0,
    tile.getValue(BoardTile, "y") ?? 0,
  );
  markerToLocal(markerEntity, worldX, worldZ);
}

function setOrderMarker(tileX: number, tileY: number, color: number): void {
  const marker = boardState.orderMarker?.object3D as Mesh | undefined;
  if (!marker) return;
  (marker.material as MeshBasicMaterial).color.setHex(color);
  const [worldX, worldZ] = gridToWorld(tileX, tileY);
  marker.position.set(worldX, marker.position.y, worldZ);
  marker.visible = true;
}

function publishSelection(unit: Entity | null): void {
  const selection = boardState.selection;
  if (!selection) return;
  selection.setValue(SelectionState, "unitIndex", unit ? unit.index : -1);
  selection.setValue(
    SelectionState,
    "unitKind",
    unit ? (unit.getValue(Unit, "kind") ?? "unknown") : "none",
  );
  selection.setValue(
    SelectionState,
    "revision",
    (selection.getValue(SelectionState, "revision") ?? 0) + 1,
  );
}

export class InteractionSystem extends createSystem({
  hoveredTiles: { required: [BoardTile, Hovered] },
  pressedTiles: { required: [BoardTile, Pressed] },
  pressedUnits: { required: [Unit, Pressed] },
  pressedEnemies: { required: [Enemy, Pressed] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
}) {
  init(): void {
    this.cleanupFuncs.push(
      this.queries.hoveredTiles.subscribe("qualify", (entity) => {
        boardState.hoveredTile = entity;
        moveMarker(boardState.hoverMarker, entity);
      }),
      this.queries.hoveredTiles.subscribe("disqualify", (entity) => {
        if (boardState.hoveredTile === entity) {
          boardState.hoveredTile = null;
          moveMarker(boardState.hoverMarker, null);
        }
      }),
      // Click a friendly unit: always (re)select — approach applies to
      // enemies and blocked terrain only (user decision 2026-07-19).
      this.queries.pressedUnits.subscribe("qualify", (entity) => {
        if (boardState.selectedUnit === entity) {
          boardState.selectedUnit = null;
          hideMarker(boardState.selectionMarker);
          publishSelection(null);
          return;
        }
        boardState.selectedUnit = entity;
        boardState.selectedTile = null;
        const holder = entity.object3D;
        if (holder) {
          markerToLocal(boardState.selectionMarker, holder.position.x, holder.position.z);
        }
        publishSelection(entity);
      }),
      // Click an enemy with a unit selected: approach the open tile on the
      // mover-facing side. The red marker stays on the unavailable target.
      this.queries.pressedEnemies.subscribe("qualify", (entity) => {
        const unit = boardState.selectedUnit;
        const enemyObject = entity.object3D;
        if (!unit || !enemyObject) return;
        const [ex, ey] = worldToGrid(enemyObject.position.x, enemyObject.position.z);
        const dest = this.nearestOpenAdjacent(ex, ey, unit);
        if (!dest) {
          setOrderMarker(ex, ey, BLOCKED_COLOR);
          return;
        }
        this.issueOrder(unit, dest[0], dest[1]);
        setOrderMarker(ex, ey, BLOCKED_COLOR);
      }),
      // Click a tile: open -> move there. Terrain features and occupied tiles
      // are unavailable destinations, so approach from the nearest open tile.
      this.queries.pressedTiles.subscribe("qualify", (entity) => {
        const unit = boardState.selectedUnit;
        if (unit) {
          const tx = entity.getValue(BoardTile, "x") ?? -1;
          const ty = entity.getValue(BoardTile, "y") ?? -1;
          const blocked = entity.getValue(BoardTile, "terrain") !== "open";
          const occupied = this.isOccupied(tx, ty, unit);
          if (!blocked && !occupied) {
            this.issueOrder(unit, tx, ty);
            setOrderMarker(tx, ty, ORDER_COLOR);
            return;
          }
          const dest = this.nearestOpenAdjacent(tx, ty, unit);
          if (dest) this.issueOrder(unit, dest[0], dest[1]);
          setOrderMarker(tx, ty, BLOCKED_COLOR);
          return;
        }
        boardState.selectedTile = entity;
        moveMarker(boardState.selectionMarker, entity);
      }),
    );
  }

  private issueOrder(unit: Entity, x: number, y: number): void {
    unit.setValue(Unit, "orderX", x);
    unit.setValue(Unit, "orderY", y);
    unit.setValue(Unit, "hasOrder", true);
  }

  private isOccupied(tx: number, ty: number, exclude: Entity): boolean {
    for (const other of this.queries.units.entities) {
      if (other === exclude) continue;
      const o = other.object3D;
      if (!o) continue;
      const [ox, oy] = worldToGrid(o.position.x, o.position.z);
      if (ox === tx && oy === ty) return true;
    }
    for (const enemy of this.queries.enemies.entities) {
      const object = enemy.object3D;
      if (!object) continue;
      const [ex, ey] = worldToGrid(object.position.x, object.position.z);
      if (ex === tx && ey === ty) return true;
    }
    return false;
  }

  private nearestOpenAdjacent(
    tx: number,
    ty: number,
    unit: Entity,
  ): [number, number] | null {
    const from = unit.object3D;
    if (!from) return null;
    const [fromX, fromY] = worldToGrid(from.position.x, from.position.z);
    const result = findApproachTile({
      target: { x: tx, y: ty },
      from: { x: fromX, y: fromY },
      gridSize: GRID_SIZE,
      canStandAt: (x, y) => {
        const tile = boardState.tileByKey.get(gridKey(x, y));
        return (
          tile?.getValue(BoardTile, "terrain") === "open" &&
          !this.isOccupied(x, y, unit)
        );
      },
    });
    return result ? [result.x, result.y] : null;
  }
}
