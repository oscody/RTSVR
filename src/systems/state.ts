import { Entity, Types, createComponent } from "@iwsdk/core";

export const BoardTile = createComponent("BoardTile", {
  x: { type: Types.Int16, default: 0 },
  y: { type: Types.Int16, default: 0 },
});

export const BoardMarker = createComponent("BoardMarker", {
  kind: { type: Types.String, default: "hover" },
});

export const boardState = {
  boardRoot: null as Entity | null,
  hoverMarker: null as Entity | null,
  selectionMarker: null as Entity | null,
  hoveredTile: null as Entity | null,
  selectedTile: null as Entity | null,
};
