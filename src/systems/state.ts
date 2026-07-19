import { Entity, Types, createComponent } from "@iwsdk/core";

export const BoardTile = createComponent("BoardTile", {
  x: { type: Types.Int16, default: 0 },
  y: { type: Types.Int16, default: 0 },
  // "open" | "crystal" (minable) | "blocked" (rocks, buildings — not walkable)
  terrain: { type: Types.String, default: "open" },
});

export const gridKey = (x: number, y: number): string => `${x},${y}`;

export const BoardMarker = createComponent("BoardMarker", {
  kind: { type: Types.String, default: "hover" },
});

// A commandable friendly unit. Order target is stored inline so the whole
// command state is readable from one ecs_query_entity call.
export const Unit = createComponent("Unit", {
  kind: { type: Types.String, default: "rover" },
  orderX: { type: Types.Int16, default: -1 },
  orderY: { type: Types.Int16, default: -1 },
  hasOrder: { type: Types.Boolean, default: false },
});

// An enemy — clickable as an approach/attack target, never commandable.
export const Enemy = createComponent("Enemy", {
  kind: { type: Types.String, default: "alien" },
});

// ECS-visible selection singleton (brushspace pattern) — one entity carries
// this; -1 / "none" means nothing selected.
export const SelectionState = createComponent("SelectionState", {
  unitIndex: { type: Types.Int32, default: -1 },
  unitKind: { type: Types.String, default: "none" },
  revision: { type: Types.Int32, default: 0 },
});

export const boardState = {
  boardRoot: null as Entity | null,
  tileByKey: new Map<string, Entity>(),
  hoverMarker: null as Entity | null,
  selectionMarker: null as Entity | null,
  orderMarker: null as Entity | null,
  selection: null as Entity | null, // carries the SelectionState singleton
  hoveredTile: null as Entity | null,
  selectedTile: null as Entity | null,
  selectedUnit: null as Entity | null,
};
