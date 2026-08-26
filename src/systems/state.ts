import { Entity, Object3D, Types, createComponent } from "@iwsdk/core";
import { UNDER_ATTACK_ALERT_VOLUME, UNIT_MOVE_SPEED } from "./constants.ts";
import {
  TURRET_ATTACK_SPEC,
  UNIT_ATTACK_SPECS,
  UNIT_MAX_HEALTH,
} from "./combatRules.js";
import {
  DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  DEFAULT_RESOURCE_CAPACITY,
  MINING_GATHER_TIME_SECONDS,
  STARTING_CRYSTALS,
} from "./economyConstants.js";
import { ALIEN_MOVE_SPEED, INITIAL_WAVE_DELAY_SECONDS } from "./waveRules.js";
import { TUTORIAL_ENABLED } from "./tutorialCatalog.ts";

export const BoardSurface = createComponent("BoardSurface", {});

export const gridKey = (x: number, y: number): string => `${x},${y}`;
export type BoardTerrain = "open" | "crystal" | "blocked";
export interface BoardCoordinate {
  x: number;
  y: number;
}

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

export const UnitSelection = createComponent("UnitSelection", {
  selected: { type: Types.Boolean, default: false },
  category: { type: Types.String, default: "command-center" },
});

// An enemy — clickable as an approach/attack target, never commandable.
export const Enemy = createComponent("Enemy", {
  kind: { type: Types.String, default: "alien" },
});

export const Health = createComponent("Health", {
  current: { type: Types.Int16, default: 100 },
  max: { type: Types.Int16, default: 100 },
});

export const CombatState = createComponent("CombatState", {
  target: { type: Types.Entity, default: null },
  targetMode: { type: Types.String, default: "none" },
  stage: { type: Types.String, default: "idle" },
  timer: { type: Types.Float32, default: 0 },
});

export const CombatCapability = createComponent("CombatCapability", {
  mode: { type: Types.String, default: "manual" },
});

export const WaveUnit = createComponent("WaveUnit", {
  stage: { type: Types.String, default: "waiting" },
  nextX: { type: Types.Int16, default: -1 },
  nextY: { type: Types.Int16, default: -1 },
  hasWaypoint: { type: Types.Boolean, default: false },
  repathTimer: { type: Types.Float32, default: 0 },
  releaseDelay: { type: Types.Float32, default: 0 },
  speedMultiplier: { type: Types.Float32, default: 1 },
});

export const WaveSource = createComponent("WaveSource", {
  waveNumber: { type: Types.Int16, default: 1 },
  timer: { type: Types.Float32, default: INITIAL_WAVE_DELAY_SECONDS },
  stage: { type: Types.String, default: "countdown" },
  // -1, not 0 — 0 is the tutorial's real wave number, and a default of 0 would
  // mean "wave 0 has already spawned" before anything had.
  spawnedWaveNumber: { type: Types.Int16, default: -1 },
  releaseTimer: { type: Types.Float32, default: 0 },
  releasedAlienCount: { type: Types.Int16, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

export const MatchState = createComponent("MatchState", {
  // Boots held, not playing — see MatchStatus in waveRules.ts for why. The
  // match starts when the player asks for it, from the landing page or by
  // entering XR.
  status: { type: Types.String, default: "awaiting-start" },
  commandCenterAlive: { type: Types.Boolean, default: true },
  revision: { type: Types.Int32, default: 0 },
});

export const MatchResultPanel = createComponent("MatchResultPanel", {
  visible: { type: Types.Boolean, default: false },
});

/**
 * Marks the standalone playtesting-settings panel.
 *
 * It is its own document, created only while the Settings tab is open, because
 * `PanelUISystem.update()` ticks every configured panel every frame regardless
 * of visibility — so the 158 setting elements cost the same hidden inside the
 * tablet as they did on screen. See `ui/rts-settings.uikitml`.
 */
export const SettingsPanel = createComponent("SettingsPanel", {
  revision: { type: Types.Int32, default: 0 },
});

// Under-attack alerting lives in its own singleton rather than in
// TabletState.status: a routine status write would immediately clobber the
// warning, and the warning would hide a victory or defeat message. Presentation
// reads this only when `revision` changes — timers and cooldown history stay
// private to UnderAttackAlertSystem instead of being rewritten into ECS.
export const UnderAttackAlertState = createComponent("UnderAttackAlertState", {
  active: { type: Types.Boolean, default: false },
  message: { type: Types.String, default: "" },
  detail: { type: Types.String, default: "" },
  priority: { type: Types.Int8, default: 0 },
  targetIndex: { type: Types.Int32, default: -1 },
  revision: { type: Types.Int32, default: 0 },
});

export const UnderAttackBanner = createComponent("UnderAttackBanner", {
  visible: { type: Types.Boolean, default: false },
});

// Tutorial progress, exposed as a singleton so it is visible to ecs_query_entity
// during debugging. Timers and the drill's kill baseline stay private to
// TutorialSystem rather than being rewritten into ECS every frame.
export const TutorialState = createComponent("TutorialState", {
  active: { type: Types.Boolean, default: false },
  /** Index into TUTORIAL_DRILLS; -1 when inactive or finished. */
  drill: { type: Types.Int8, default: -1 },
  title: { type: Types.String, default: "" },
  body: { type: Types.String, default: "" },
  /** Set while a lost unit needs replacing; blank otherwise. */
  recovery: { type: Types.String, default: "" },
  /**
   * Gaze-ring fill, 0..1. Exposed for the same reason the rest of this
   * component is: the wedges are nested deeper than `scene hierarchy` reaches,
   * so this is the only way to read the ring from outside the app.
   */
  gaze: { type: Types.Float32, default: 0 },
  deadEnd: { type: Types.Boolean, default: false },
  revision: { type: Types.Int32, default: 0 },
});

export const ScenarioObject = createComponent("ScenarioObject", {});

export const ResourceNode = createComponent("ResourceNode", {
  kind: { type: Types.String, default: "small" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  capacity: { type: Types.Int16, default: DEFAULT_RESOURCE_CAPACITY },
  remaining: { type: Types.Int16, default: DEFAULT_RESOURCE_CAPACITY },
  amountPerTrip: {
    type: Types.Int16,
    default: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  },
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
  crystals: { type: Types.Int32, default: STARTING_CRYSTALS },
  revision: { type: Types.Int32, default: 0 },
});

export const GameStats = createComponent("GameStats", {
  crystalsMined: { type: Types.Int32, default: 0 },
  enemiesKilled: { type: Types.Int32, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

export const RuntimePerformance = createComponent("RuntimePerformance", {
  fps: { type: Types.Float32, default: 0 },
  averageFrameMs: { type: Types.Float32, default: 0 },
  worstFrameMs: { type: Types.Float32, default: 0 },
  movingEntities: { type: Types.Int16, default: 0 },
  // Live enemy count, published alongside the frame sample so the profiler's
  // context line can report scene load without needing its own ECS query.
  enemiesAlive: { type: Types.Int16, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

export const Building = createComponent("Building", {
  kind: { type: Types.String, default: "unknown" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  widthTiles: { type: Types.Int8, default: 1 },
});

// The build order itself. It exists as a board object from the moment the
// player places it — before any astronaut is involved — and it owns the timer,
// so it completes exactly once regardless of how many builders attach to it.
// `beaconBuilder` is the one astronaut playing BeaconPlacement; every other
// assigned builder plays LaserPointAssist.
export const ConstructionSite = createComponent("ConstructionSite", {
  kind: { type: Types.String, default: "none" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  widthTiles: { type: Types.Int8, default: 1 },
  progress: { type: Types.Float32, default: 0 },
  stage: { type: Types.String, default: "pending" },
  timer: { type: Types.Float32, default: 0 },
  duration: { type: Types.Float32, default: 0 },
  cost: { type: Types.Int16, default: 0 },
  builderCount: { type: Types.Int8, default: 0 },
  beaconBuilder: { type: Types.Entity, default: null },
  // Position in the global build queue, assigned at placement from
  // boardState.nextQueueOrder. Lower builds first, and Cancel starts here.
  queueOrder: { type: Types.Int32, default: 0 },
});

// Same shape of idea as ConstructionSite: the order is a board object that owns
// its own timer. Crafts now also need an astronaut to come and work on them
// (`requiresBuilder`), so they share the builder fields and the multi-builder
// speed-up. Astronaut production is the one exemption — it self-builds, because
// if making an astronaut required an astronaut, losing your last one would end
// the game with no way to recover.
export const CraftProductionSite = createComponent("CraftProductionSite", {
  kind: { type: Types.String, default: "none" },
  sourceKind: { type: Types.String, default: "command-center" },
  x: { type: Types.Int16, default: -1 },
  y: { type: Types.Int16, default: -1 },
  timer: { type: Types.Float32, default: 0 },
  duration: { type: Types.Float32, default: 0 },
  progress: { type: Types.Float32, default: 0 },
  cost: { type: Types.Int16, default: 0 },
  stage: { type: Types.String, default: "pending" },
  requiresBuilder: { type: Types.Boolean, default: false },
  builderCount: { type: Types.Int8, default: 0 },
  beaconBuilder: { type: Types.Entity, default: null },
  // Same global queue as building sites: a turret, a hangar and a mining craft
  // placed in that order are 1, 2, 3 together, because they all compete for the
  // same astronauts.
  queueOrder: { type: Types.Int32, default: 0 },
});

// A builder's ROLE only. What is being built, how far along it is, and what it
// cost all live on the ConstructionSite now; this just records which site this
// astronaut is assigned to and whether it is walking there or working on it.
export const ConstructionState = createComponent("ConstructionState", {
  stage: { type: Types.String, default: "idle" },
  approachX: { type: Types.Int16, default: -1 },
  approachY: { type: Types.Int16, default: -1 },
  site: { type: Types.Entity, default: null },
});

export const TabletState = createComponent("TabletState", {
  view: { type: Types.String, default: "overview" },
  astronaut: { type: Types.Entity, default: null },
  astronautIndex: { type: Types.Int32, default: -1 },
  selectedBuildingKind: { type: Types.String, default: "none" },
  buildPlacementActive: { type: Types.Boolean, default: false },
  // The building that will produce the next craft. Only ever set to a building
  // that CAN produce, so clicking a turret cannot poison it.
  spawnBuilding: { type: Types.Entity, default: null },
  spawnBuildingIndex: { type: Types.Int32, default: -1 },
  // The building the player last clicked, whatever it is. Drives the Destroy
  // action. Deliberately separate from spawnBuilding: "what I am looking at"
  // and "what will build my craft" are different questions.
  focusBuilding: { type: Types.Entity, default: null },
  focusBuildingIndex: { type: Types.Int32, default: -1 },
  // The construction site the player has clicked, if any — drives the Cancel
  // action in the Build tab.
  selectedSite: { type: Types.Entity, default: null },
  selectedSiteIndex: { type: Types.Int32, default: -1 },
  selectedCraftKind: { type: Types.String, default: "none" },
  selectedCraftCost: { type: Types.Int16, default: 0 },
  craftPage: { type: Types.Int16, default: 0 },
  craftPlacementActive: { type: Types.Boolean, default: false },
  unitFilter: { type: Types.String, default: "all" },
  unitPage: { type: Types.Int16, default: 0 },
  status: { type: Types.String, default: "Select an astronaut to build" },
  statusKind: { type: Types.String, default: "info" },
  revision: { type: Types.Int32, default: 0 },
});

// ECS-visible selection singleton (brushspace pattern) — one entity carries
// this; -1 / "none" means nothing selected.
export const SelectionState = createComponent("SelectionState", {
  unitIndex: { type: Types.Int32, default: -1 },
  unitKind: { type: Types.String, default: "none" },
  selectedCount: { type: Types.Int16, default: 0 },
  revision: { type: Types.Int32, default: 0 },
});

// Live-tunable playtesting knobs, exposed on the tablet's Settings tab.
// Deliberately NOT reset by ScenarioResetSystem — a debug panel is only
// useful if a tweak survives Restart within the same play session.
// waveMaxActiveAliens/waveReleaseIntervalSeconds are reseeded from that
// wave's own catalog-scaled pacing every time a new wave spawns (see
// WaveSystem.spawnWaveIfNeeded), so per-wave difficulty scaling still
// applies by default; these fields are just the current override layer.
export const DebugSettings = createComponent("DebugSettings", {
  alienMoveSpeed: { type: Types.Float32, default: ALIEN_MOVE_SPEED },
  unitMoveSpeed: { type: Types.Float32, default: UNIT_MOVE_SPEED },
  initialWaveDelaySeconds: {
    type: Types.Float32,
    default: INITIAL_WAVE_DELAY_SECONDS,
  },
  waveMaxActiveAliens: { type: Types.Int16, default: 3 },
  waveReleaseIntervalSeconds: { type: Types.Float32, default: 8 },
  turretRange: { type: Types.Float32, default: TURRET_ATTACK_SPEC.range },
  astronautAttackRange: {
    type: Types.Float32,
    default: UNIT_ATTACK_SPECS.astronaut.range,
  },
  craftRacerAttackRange: {
    type: Types.Float32,
    default: UNIT_ATTACK_SPECS.racer.range,
  },
  buildingHealthScale: { type: Types.Float32, default: 1 },
  astronautHealth: {
    type: Types.Float32,
    default: UNIT_MAX_HEALTH.astronaut,
  },
  craftRacerHealth: {
    type: Types.Float32,
    default: UNIT_MAX_HEALTH.racer,
  },
  craftMinerHealth: {
    type: Types.Float32,
    default: UNIT_MAX_HEALTH.miner,
  },
  alienHealthScale: { type: Types.Float32, default: 1 },
  astronautAttackDamage: {
    type: Types.Float32,
    default: UNIT_ATTACK_SPECS.astronaut.damage,
  },
  craftRacerAttackDamage: {
    type: Types.Float32,
    default: UNIT_ATTACK_SPECS.racer.damage,
  },
  turretAttackDamage: {
    type: Types.Float32,
    default: TURRET_ATTACK_SPEC.damage,
  },
  miningGatherTimeSeconds: {
    type: Types.Float32,
    default: MINING_GATHER_TIME_SECONDS,
  },
  // 0/1 rather than Boolean so it reuses the Settings tab's numeric +/- rows
  // wholesale — no new markup pattern, no new TabletSystem branch.
  tutorialEnabled: {
    type: Types.Float32,
    default: TUTORIAL_ENABLED ? 1 : 0,
  },
  underAttackAlertVolume: {
    type: Types.Float32,
    default: UNDER_ATTACK_ALERT_VOLUME,
  },
  revision: { type: Types.Int32, default: 0 },
});

// The tunable-field subset of DebugSettings (excludes "revision") — shared
// with debugSettingsCatalog.ts so its spec table's `key` is checked against
// the component's real field names instead of a plain string.
export type DebugSettingKey =
  | "alienMoveSpeed"
  | "unitMoveSpeed"
  | "initialWaveDelaySeconds"
  | "waveMaxActiveAliens"
  | "waveReleaseIntervalSeconds"
  | "turretRange"
  | "astronautAttackRange"
  | "craftRacerAttackRange"
  | "buildingHealthScale"
  | "astronautHealth"
  | "craftRacerHealth"
  | "craftMinerHealth"
  | "alienHealthScale"
  | "astronautAttackDamage"
  | "craftRacerAttackDamage"
  | "turretAttackDamage"
  | "miningGatherTimeSeconds"
  | "underAttackAlertVolume"
  | "tutorialEnabled";

export const boardState = {
  boardRoot: null as Entity | null,
  boardSurface: null as Entity | null,
  gridOverlay: null as Entity | null, // command grid, shown while units selected
  terrainByKey: new Map<string, BoardTerrain>(),
  hoverMarker: null as Entity | null,
  selectionMarker: null as Entity | null,
  orderMarker: null as Entity | null,
  buildMarker: null as Entity | null,
  selection: null as Entity | null, // carries the SelectionState singleton
  gameState: null as Entity | null,
  gameStats: null as Entity | null,
  runtimePerformance: null as Entity | null,
  waveSource: null as Entity | null,
  matchResultPanel: null as Entity | null,
  underAttackAlert: null as Entity | null, // carries UnderAttackAlertState
  underAttackBanner: null as Entity | null, // command-center warning panel
  tutorial: null as Entity | null, // carries the TutorialState singleton
  tablet: null as Entity | null,
  commandCenter: null as Entity | null,
  pointerTile: null as BoardCoordinate | null,
  hoveredTile: null as BoardCoordinate | null,
  selectedTile: null as BoardCoordinate | null,
  selectedUnit: null as Entity | null,
  selectedSite: null as Entity | null, // clicked ConstructionSite, for cancel
  selectedUnits: new Set<Entity>(),
  selectionRingByUnit: new Map<number, Entity>(),
  attackRangeRingByUnit: new Map<number, Entity>(),
  selectedTurret: null as Entity | null,
  rangeRingByTurret: new Map<number, Entity>(),
  // Enemy inspection: click an alien with nothing of yours selected to see its
  // threat radius. Keyed by entity index, so both disposal paths must delete.
  selectedEnemy: null as Entity | null,
  rangeRingByEnemy: new Map<number, Entity>(),
  resourceByKey: new Map<string, Entity>(),
  cargoVisualByUnit: new Map<number, Object3D>(),
  pathByUnit: new Map<number, { x: number; y: number }[]>(),
  // Rebuilt in place each frame by ConstructionSystem: which astronauts are
  // attached to each construction site (by site entity index). Read by the
  // animation system to decide beacon-vs-assist roles.
  buildersBySite: new Map<number, Entity[]>(),
  // Monotonic counter handing out build-queue positions. Reset on restart.
  nextQueueOrder: 1,
  // Republished each frame by ConstructionSystem: every live build site of
  // either kind, so the tablet can resolve its Cancel target without a query.
  liveSites: [] as Entity[],
  debugSettings: null as Entity | null,
};

export function getTerrainAt(x: number, y: number): BoardTerrain | null {
  return boardState.terrainByKey.get(gridKey(x, y)) ?? null;
}

export function setTerrainAt(
  x: number,
  y: number,
  terrain: BoardTerrain,
): boolean {
  const key = gridKey(x, y);
  if (!boardState.terrainByKey.has(key)) return false;
  boardState.terrainByKey.set(key, terrain);
  return true;
}

export function resetBoardTerrain(): void {
  for (const key of boardState.terrainByKey.keys()) {
    boardState.terrainByKey.set(key, "open");
  }
}
