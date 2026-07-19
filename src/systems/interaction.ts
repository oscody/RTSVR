import { Entity, Hovered, Pressed, createSystem } from "@iwsdk/core";
import { gridToWorld } from "./board.js";
import { BoardTile, boardState } from "./state.js";

function moveMarker(markerEntity: Entity | null, tile: Entity | null): void {
  const marker = markerEntity?.object3D;
  if (!marker) return;
  if (!tile) {
    marker.visible = false;
    return;
  }
  const [worldX, worldZ] = gridToWorld(
    tile.getValue(BoardTile, "x") ?? 0,
    tile.getValue(BoardTile, "y") ?? 0,
  );
  marker.position.set(worldX, 0.023, worldZ);
  marker.visible = true;
}

export class InteractionSystem extends createSystem({
  hoveredTiles: { required: [BoardTile, Hovered] },
  pressedTiles: { required: [BoardTile, Pressed] },
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
      this.queries.pressedTiles.subscribe("qualify", (entity) => {
        boardState.selectedTile = entity;
        moveMarker(boardState.selectionMarker, entity);
      }),
    );
  }
}
