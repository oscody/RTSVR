import { Entity, Hovered, Pressed, createSystem } from "@iwsdk/core";
import { gridToWorld, worldToGrid } from "./board.js";
import { BoardTile, SelectionState, Unit, boardState } from "./state.js";

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
      // Click a unit: select it (click the selected unit again to deselect).
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
      // Click a tile: with a unit selected this is a move order; otherwise
      // it is a plain tile selection (kept for future build placement).
      this.queries.pressedTiles.subscribe("qualify", (entity) => {
        const unit = boardState.selectedUnit;
        if (unit) {
          // Orders into blocked terrain (rocks, buildings, aliens) are refused.
          if (entity.getValue(BoardTile, "terrain") === "blocked") return;
          // Orders onto a tile currently occupied by another unit are refused
          // (units move, so occupancy is checked live, not stamped).
          const tx = entity.getValue(BoardTile, "x") ?? -1;
          const ty = entity.getValue(BoardTile, "y") ?? -1;
          for (const other of this.queries.units.entities) {
            if (other === unit) continue;
            const o = other.object3D;
            if (!o) continue;
            const [ox, oy] = worldToGrid(o.position.x, o.position.z);
            if (ox === tx && oy === ty) return;
          }
          unit.setValue(Unit, "orderX", entity.getValue(BoardTile, "x") ?? -1);
          unit.setValue(Unit, "orderY", entity.getValue(BoardTile, "y") ?? -1);
          unit.setValue(Unit, "hasOrder", true);
          moveMarker(boardState.orderMarker, entity);
          return;
        }
        boardState.selectedTile = entity;
        moveMarker(boardState.selectionMarker, entity);
      }),
    );
  }
}
