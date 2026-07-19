import {
  Entity,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  Pressed,
  createSystem,
} from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import { BoardTile, Enemy, SelectionState, Unit, boardState } from "./state.js";

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
      // Click an enemy with a unit selected: approach — walk to the open
      // tile "in front of" it (nearest the mover). Orange marker at the
      // destination; the enemy itself is the implied target.
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
        setOrderMarker(dest[0], dest[1], ORDER_COLOR);
      }),
      // Click a tile: open → move there. Blocked or occupied → approach the
      // nearest open adjacent tile, with a RED marker on the clicked tile.
      this.queries.pressedTiles.subscribe("qualify", (entity) => {
        const unit = boardState.selectedUnit;
        if (unit) {
          const tx = entity.getValue(BoardTile, "x") ?? -1;
          const ty = entity.getValue(BoardTile, "y") ?? -1;
          const blocked = entity.getValue(BoardTile, "terrain") === "blocked";
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
    return false;
  }

  // Nearest walkable tile adjacent to (tx,ty), preferring the side facing
  // the moving unit. Searches ring radius 1 then 2 (radius 2 covers clicks
  // on the center of a 3x3 building footprint).
  private nearestOpenAdjacent(
    tx: number,
    ty: number,
    unit: Entity,
  ): [number, number] | null {
    const from = unit.object3D;
    if (!from) return null;
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    for (let radius = 1; radius <= 2 && !best; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) continue;
          const tile = boardState.tileByKey.get(`${x},${y}`);
          if (!tile) continue;
          if (tile.getValue(BoardTile, "terrain") === "blocked") continue;
          if (this.isOccupied(x, y, unit)) continue;
          const [wx, wz] = gridToWorld(x, y);
          const ddx = wx - from.position.x;
          const ddz = wz - from.position.z;
          const distance = ddx * ddx + ddz * ddz;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = [x, y];
          }
        }
      }
    }
    return best;
  }
}
