import { Entity, Object3D, Types, createComponent } from "@iwsdk/core";

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

export const ResourceNode = createComponent("ResourceNode", {
  kind: { type: Types.String, default: "small" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  capacity: { type: Types.Int16, default: 50 },
  remaining: { type: Types.Int16, default: 50 },
  amountPerTrip: { type: Types.Int16, default: 10 },
});

export const MinerState = createComponent("MinerState", {
  stage: { type: Types.String, default: "idle" },
  timer: { type: Types.Float32, default: 0 },
  cargo: { type: Types.Int16, default: 0 },
  target: { type: Types.Entity, default: null },
  targetX: { type: Types.Int16, default: -1 },
  targetY: { type: Types.Int16, default: -1 },
  approachX: { type: Types.Int16, default: -1 },
  approachY: { type: Types.Int16, default: -1 },
  depositX: { type: Types.Int16, default: -1 },
  depositY: { type: Types.Int16, default: -1 },
});

export const GameState = createComponent("GameState", {
  crystals: { type: Types.Int32, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

export const GameStats = createComponent("GameStats", {
  crystalsMined: { type: Types.Int32, default: 0 },
  enemiesKilled: { type: Types.Int32, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

export const Building = createComponent("Building", {
  kind: { type: Types.String, default: "unknown" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  widthTiles: { type: Types.Int8, default: 1 },
});

export const ConstructionSite = createComponent("ConstructionSite", {
  kind: { type: Types.String, default: "none" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  widthTiles: { type: Types.Int8, default: 1 },
  progress: { type: Types.Float32, default: 0 },
});

export const ConstructionState = createComponent("ConstructionState", {
  stage: { type: Types.String, default: "idle" },
  buildingKind: { type: Types.String, default: "none" },
  targetX: { type: Types.Int16, default: -1 },
  targetY: { type: Types.Int16, default: -1 },
  approachX: { type: Types.Int16, default: -1 },
  approachY: { type: Types.Int16, default: -1 },
  timer: { type: Types.Float32, default: 0 },
  duration: { type: Types.Float32, default: 0 },
  cost: { type: Types.Int16, default: 0 },
  site: { type: Types.Entity, default: null },
});

export const TabletState = createComponent("TabletState", {
  view: { type: Types.String, default: "overview" },
  astronaut: { type: Types.Entity, default: null },
  astronautIndex: { type: Types.Int32, default: -1 },
  selectedBuildingKind: { type: Types.String, default: "none" },
  status: { type: Types.String, default: "Select an astronaut to build" },
  statusKind: { type: Types.String, default: "info" },
  revision: { type: Types.Int32, default: 0 },
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
  buildMarker: null as Entity | null,
  selection: null as Entity | null, // carries the SelectionState singleton
  gameState: null as Entity | null,
  gameStats: null as Entity | null,
  tablet: null as Entity | null,
  commandCenter: null as Entity | null,
  hoveredTile: null as Entity | null,
  selectedTile: null as Entity | null,
  selectedUnit: null as Entity | null,
  resourceByKey: new Map<string, Entity>(),
  cargoVisualByUnit: new Map<number, Object3D>(),
  pathByUnit: new Map<number, { x: number; y: number }[]>(),
};
