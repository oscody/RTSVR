import {
  AssetManager,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RayInteractable,
  Vector3,
  createSystem,
  type Entity,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE, gridToWorld } from "./board.js";
import {
  ALIEN_DRAKE_VISUAL_ELEVATION,
  CRAFT_VISUAL_ELEVATION,
} from "./constants.ts";
import {
  canUnitAttack,
} from "./combatRules.js";
import {
  currentBuildingMaxHealth,
  currentEnemyMaxHealth,
  currentUnitMaxHealth,
} from "./debugStatOverrides.js";
import {
  DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  LARGE_CRYSTAL_NODE_CAPACITY,
  SMALL_CRYSTAL_NODE_CAPACITY,
} from "./economyConstants.js";
import { attachAlienAnimation } from "./alienAnimation.js";
import { attachCommandCenterAnimation } from "./commandCenterAnimation.js";
import { attachHealthBar } from "./healthBar.js";
import { UNIT_BOX_GEOMETRY } from "./sharedGeometry.js";
import { attachMinerAnimation } from "./minerAnimation.js";
import { attachTurretAnimation } from "./turretAnimation.js";
import { isTutorialEnabled } from "./tutorial.js";
import { attachUnitAnimation } from "./unitAnimation.js";
import {
  type BoardTerrain,
  Building,
  CombatCapability,
  CombatState,
  ConstructionState,
  Enemy,
  Health,
  MinerState,
  ResourceNode,
  ScenarioObject,
  Unit,
  UnitSelection,
  WaveUnit,
  boardState,
  setTerrainAt,
  gridKey,
} from "./state.js";

// Placement is tile-aligned: footprint in tiles, centered between the listed
// grid columns/rows, one empty tile between neighboring structures.
interface StructureSpec {
  asset: string;
  name: string;
  /** target footprint width in tiles (x) — scale is derived from this */
  widthTiles: number;
  /** grid cells whose midpoint becomes the structure center */
  gridX: [number, number];
  gridY: [number, number];
  /** counter-rotation for models whose geometry is baked in diagonally */
  yawDeg?: number;
  /** commandable friendly unit: attaches Unit {kind} + RayInteractable */
  unit?: string;
  /** building category shown by the live unit roster */
  unitCategory?: string;
  /** stamps the tiles under the footprint: "crystal" (minable) | "blocked" */
  terrain?: BoardTerrain;
  /** finite crystal deposit configuration */
  resource?: { kind: "small" | "large"; capacity: number };
  /** friendly building category used by construction and production */
  building?: string;
}

export interface EnemyEntitySpec {
  asset: string;
  name: string;
  kind: string;
  widthTiles: number;
  x: number;
  y: number;
  yawDeg?: number;
  healthMultiplier?: number;
}

interface InteractionProxySpec {
  name: string;
  widthTiles: number;
}

const STRUCTURES: StructureSpec[] = [
  // 15m-wide model scaled onto 3x3 tiles, board center (tiles 10-12).
  { asset: "commandCenter", name: "CommandCenter", widthTiles: 3, gridX: [11, 11], gridY: [11, 11], terrain: "blocked", building: "command-center" },

  // Crystal field A — front-left, close to the base cluster (early mining).
  { asset: "rockCrystalsLargeA", name: "CrystalLargeA", widthTiles: 1, gridX: [5, 5], gridY: [16, 16], terrain: "crystal", resource: { kind: "large", capacity: LARGE_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalSmallA", widthTiles: 1, gridX: [6, 6], gridY: [17, 17], terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },
  { asset: "rocksSmallB", name: "RocksSmallB", widthTiles: 1, gridX: [4, 4], gridY: [17, 17], terrain: "blocked" },
  // Crystal field B — back-right expansion.
  { asset: "rockCrystalsLargeB", name: "CrystalLargeB", widthTiles: 1, gridX: [18, 18], gridY: [6, 6], terrain: "crystal", resource: { kind: "large", capacity: LARGE_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalSmallB", widthTiles: 1, gridX: [19, 19], gridY: [7, 7], terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },
  // Crystal field expansions.
  { asset: "rockCrystalsLargeB", name: "CrystalA3", widthTiles: 1, gridX: [4, 4], gridY: [15, 15], terrain: "crystal", resource: { kind: "large", capacity: LARGE_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalA4", widthTiles: 1, gridX: [5, 5], gridY: [18, 18], yawDeg: 90, terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystalsLargeA", name: "CrystalB3", widthTiles: 1, gridX: [17, 17], gridY: [5, 5], yawDeg: 180, terrain: "crystal", resource: { kind: "large", capacity: LARGE_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalB4", widthTiles: 1, gridX: [20, 20], gridY: [6, 6], yawDeg: 90, terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },
  // Crystal field C — front-right pocket.
  { asset: "rockCrystalsLargeB", name: "CrystalC1", widthTiles: 1, gridX: [19, 19], gridY: [17, 17], yawDeg: 270, terrain: "crystal", resource: { kind: "large", capacity: LARGE_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalC2", widthTiles: 1, gridX: [20, 20], gridY: [16, 16], terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },
  { asset: "rockCrystals", name: "CrystalBaseA", widthTiles: 1, gridX: [8, 8], gridY: [11, 11], terrain: "crystal", resource: { kind: "small", capacity: SMALL_CRYSTAL_NODE_CAPACITY } },

  // Landmark boulder — a rockLargeA scaled onto 2x2 tiles, north of the base.
  { asset: "rockLargeA", name: "BoulderLarge", widthTiles: 2, gridX: [11, 12], gridY: [4, 4], terrain: "blocked" },

  // Scattered rocks — dressing.
  { asset: "rockLargeA", name: "RockLargeA", widthTiles: 1, gridX: [3, 3], gridY: [4, 4], terrain: "blocked" },
  { asset: "rockLargeB", name: "RockLargeB", widthTiles: 1, gridX: [20, 20], gridY: [19, 19], terrain: "blocked" },
  { asset: "rocksSmallA", name: "RocksSmallA", widthTiles: 1, gridX: [16, 16], gridY: [20, 20], terrain: "blocked" },
  { asset: "rock", name: "Rock", widthTiles: 1, gridX: [8, 8], gridY: [5, 5], terrain: "blocked" },
  { asset: "rock", name: "Rock2", widthTiles: 1, gridX: [2, 2], gridY: [10, 10], yawDeg: 90, terrain: "blocked" },
  { asset: "rocksSmallA", name: "RocksSmallA2", widthTiles: 1, gridX: [2, 2], gridY: [18, 18], terrain: "blocked" },
  { asset: "rockLargeB", name: "RockLargeB2", widthTiles: 1, gridX: [6, 6], gridY: [3, 3], yawDeg: 90, terrain: "blocked" },
  { asset: "rocksSmallB", name: "RocksSmallB2", widthTiles: 1, gridX: [13, 13], gridY: [19, 19], yawDeg: 180, terrain: "blocked" },
  { asset: "rock", name: "Rock3", widthTiles: 1, gridX: [17, 17], gridY: [14, 14], yawDeg: 180, terrain: "blocked" },
  { asset: "rocksSmallA", name: "RocksSmallA3", widthTiles: 1, gridX: [10, 10], gridY: [21, 21], yawDeg: 90, terrain: "blocked" },
  { asset: "rock", name: "Rock4", widthTiles: 1, gridX: [21, 21], gridY: [11, 11], yawDeg: 270, terrain: "blocked" },
  { asset: "rocksSmallB", name: "RocksSmallB3", widthTiles: 1, gridX: [22, 22], gridY: [3, 3], terrain: "blocked" },
  { asset: "rockLargeB", name: "RockLargeB3", widthTiles: 1, gridX: [14, 14], gridY: [6, 6], yawDeg: 270, terrain: "blocked" },

  // Crew — flanking the command center's front corners.
  { asset: "astronautAAnimated", name: "AstronautA", widthTiles: 1, gridX: [9, 9], gridY: [12, 12], yawDeg: 180, unit: "astronaut", unitCategory: "command-center" },
  // { asset: "astronautB", name: "AstronautB", widthTiles: 1, gridX: [13, 13], gridY: [12, 12], yawDeg: 180, unit: "astronaut", unitCategory: "command-center" },

  { asset: "craftMinerAnimated", name: "CraftMiner", widthTiles: 1, gridX: [11, 11], gridY: [13, 13], yawDeg: 180, unit: "miner", unitCategory: "factory" },
  // // Base defense — two turrets flanking opposite corners of the command center.
  // { asset: "turretSingle", name: "TurretSingle", widthTiles: 1, gridX: [13, 13], gridY: [9, 9], yawDeg: 180, terrain: "blocked", building: "turret" },
  // { asset: "turretSingle", name: "TurretSingle2", widthTiles: 1, gridX: [9, 9], gridY: [13, 13], yawDeg: 180, terrain: "blocked", building: "turret" },


  // Meteors — sprinkled impact debris.
  { asset: "meteor", name: "Meteor1", widthTiles: 1, gridX: [2, 2], gridY: [2, 2], terrain: "blocked" },
  { asset: "meteorDetailed", name: "Meteor2", widthTiles: 1, gridX: [10, 10], gridY: [2, 2], yawDeg: 90, terrain: "blocked" },
  { asset: "meteorHalf", name: "Meteor3", widthTiles: 1, gridX: [15, 15], gridY: [3, 3], yawDeg: 180, terrain: "blocked" },
  { asset: "meteor", name: "Meteor4", widthTiles: 1, gridX: [1, 1], gridY: [14, 14], yawDeg: 270, terrain: "blocked" },
  { asset: "meteorDetailed", name: "Meteor5", widthTiles: 1, gridX: [22, 22], gridY: [18, 18], terrain: "blocked" },
  { asset: "meteorHalf", name: "Meteor6", widthTiles: 1, gridX: [17, 17], gridY: [21, 21], yawDeg: 90, terrain: "blocked" },
  { asset: "meteor", name: "Meteor7", widthTiles: 1, gridX: [7, 7], gridY: [20, 20], yawDeg: 180, terrain: "blocked" },
];

// Re-center a loaded model from its measured bounds: footprint centered on
// the group origin, base seated at y 0. Neutralizes baked pivot offsets
// (hangar_largeA carries a (2, 0, 1.5) node translation) and below-ground
// origins (building-r's base sits at y -1) in one step.
// Mark the board tiles under a structure's footprint (widthTiles square,
// centered on the grid span's midpoint) so mining/pathing can read them.
function stampTerrain(spec: StructureSpec, terrain: BoardTerrain): void {
  const w = spec.widthTiles;
  const startX = Math.round((spec.gridX[0] + spec.gridX[1]) / 2 - (w - 1) / 2);
  const startY = Math.round((spec.gridY[0] + spec.gridY[1]) / 2 - (w - 1) / 2);
  for (let y = startY; y < startY + w; y += 1) {
    for (let x = startX; x < startX + w; x += 1) {
      setTerrainAt(x, y, terrain);
    }
  }
}

function seatModel(
  model: Object3D,
  box: Box3 = new Box3().setFromObject(model),
): void {
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}

function structureVisualElevation(spec: StructureSpec): number {
  return isHoverCraftAsset(spec.asset) ? CRAFT_VISUAL_ELEVATION : 0;
}

function enemyVisualElevation(spec: EnemyEntitySpec): number {
  return spec.kind === "alienDrake" ? ALIEN_DRAKE_VISUAL_ELEVATION : 0;
}

function isHoverCraftAsset(asset: string): boolean {
  return asset === "craftRacer";
}

const interactionProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

function addInteractionProxy(
  holder: Group,
  spec: InteractionProxySpec,
  model: Object3D,
  visualYOffset = 0,
  measuredSize?: Vector3,
): void {
  const size =
    measuredSize ?? new Box3().setFromObject(model).getSize(new Vector3());
  const footprint = spec.widthTiles * TILE_SIZE * 0.82;
  const height = Math.max(size.y + visualYOffset, TILE_SIZE * 0.8);
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, interactionProxyMaterial);
  proxy.name = `${spec.name}InteractionProxy`;
  proxy.scale.set(footprint, height, footprint);
  proxy.position.y = height / 2;
  proxy.userData.drawCat = "proxy"; // draw-call profiler category
  holder.add(proxy);
}

// XR pointer input recurses through every mesh under a RayInteractable holder
// and raycasts each one, for both hands, every frame. Alien GLBs carry ~70 mesh
// primitives (drake/mech), so hit-testing the full visual model is the dominant
// `Input` cost in later waves (Quest 2026-07-31: Input scaled ~5.6 -> ~13.4 ms
// with live alien count). Selection only needs the tile-sized box proxy, so make
// the visual model non-raycastable and let the proxy be the sole ray target.
// Visuals are unaffected — this only changes hit-testing, not rendering.
export function disableModelRaycast(model: Object3D): void {
  model.traverse((child) => {
    if ((child as Mesh).isMesh) {
      child.raycast = () => {};
    }
  });
}

function addCargoVisual(
  holder: Group,
  model: Object3D,
  visualYOffset: number,
): Object3D {
  const cargo = AssetManager.getGLTF("rockCrystals")?.scene;
  if (!cargo) throw new Error("rockCrystals not preloaded for miner cargo");
  const cargoWidth = new Box3().setFromObject(cargo).getSize(new Vector3()).x;
  cargo.scale.setScalar((TILE_SIZE * 0.3) / cargoWidth);
  seatModel(cargo);
  const modelHeight = new Box3().setFromObject(model).getSize(new Vector3()).y;
  cargo.name = "MinerCargoVisual";
  cargo.position.y = visualYOffset + modelHeight + TILE_SIZE * 0.04;
  cargo.visible = false;
  holder.add(cargo);
  return cargo;
}

export function createEnemyEntity(
  world: World,
  parent: Entity,
  spec: EnemyEntitySpec,
): Entity {
  const gltf = AssetManager.getGLTF(spec.asset);
  if (!gltf) throw new Error(`${spec.asset} not preloaded`);
  const model = gltf.scene;
  const modelBox = new Box3().setFromObject(model);
  const modelSize = modelBox.getSize(new Vector3());
  const width = modelSize.x;
  const scale = (spec.widthTiles * TILE_SIZE) / width;
  const previousScale = model.scale.x || 1;
  const scaleRatio = scale / previousScale;
  model.scale.setScalar(scale);
  modelBox.min
    .sub(model.position)
    .multiplyScalar(scaleRatio)
    .add(model.position);
  modelBox.max
    .sub(model.position)
    .multiplyScalar(scaleRatio)
    .add(model.position);
  modelSize.multiplyScalar(scaleRatio);
  seatModel(model, modelBox);
  const visualYOffset = enemyVisualElevation(spec);
  model.position.y += visualYOffset;

  const holder = new Group();
  holder.name = spec.name;
  holder.visible = false;
  holder.userData.drawCat = "alien"; // draw-call profiler category
  if (spec.yawDeg !== undefined) {
    holder.rotation.y = (spec.yawDeg * Math.PI) / 180;
  }
  const [worldX, worldZ] = gridToWorld(spec.x, spec.y);
  holder.position.set(worldX, 0.006, worldZ);
  holder.add(model);
  disableModelRaycast(model);
  addInteractionProxy(holder, spec, model, visualYOffset, modelSize);

  const maxHealth = currentEnemyMaxHealth(
    spec.kind,
    spec.healthMultiplier ?? 1,
  );
  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(Enemy, { kind: spec.kind })
    .addComponent(Health, { current: maxHealth, max: maxHealth })
    .addComponent(CombatState)
    .addComponent(WaveUnit);

  if (
    spec.asset === "alienWalkingSlam" ||
    spec.asset === "alienDrakeFlyingAttack" ||
    spec.asset === "strongAlienMech"
  ) {
    attachAlienAnimation(entity, model, gltf.animations);
  }
  attachHealthBar(holder);
  return entity;
}

/**
 * Structures the tutorial's bare start leaves out.
 *
 * The tutorial teaches the astronaut as its own drill — "your builder, and it
 * can fight" — which is meaningless if the player already has one standing next
 * to the base. Starting with only a miner is also what makes the drill ORDER
 * forced rather than chosen: with 0 crystals and no builder, mining is the only
 * action available at t=0.
 */
const TUTORIAL_OMITTED_STRUCTURES: ReadonlySet<string> = new Set(["AstronautA"]);

export function createInitialScenario(
  world: World,
  options: { bareStart?: boolean } = {},
): void {
  const root = boardState.boardRoot;
  if (!root) throw new Error("Initial scenario requires BoardSystem first");

  for (const spec of STRUCTURES) {
      if (options.bareStart && TUTORIAL_OMITTED_STRUCTURES.has(spec.name)) {
        continue;
      }
      const gltf = AssetManager.getGLTF(spec.asset);
      if (!gltf) throw new Error(`${spec.asset} not preloaded`);
      const model = gltf.scene;

      // Rotate BEFORE measuring/seating so bounds reflect the final pose.
      if (spec.yawDeg) {
        model.rotation.y = (spec.yawDeg * Math.PI) / 180;
      }

      const width = new Box3().setFromObject(model).getSize(new Vector3()).x;
      const scale = (spec.widthTiles * TILE_SIZE) / width;
      model.scale.setScalar(scale);
      seatModel(model);
      const visualYOffset = structureVisualElevation(spec);
      model.position.y += visualYOffset;

      const holder = new Group();
      holder.name = spec.name;
      // draw-call profiler category (units/buildings; static props inherit "static")
      if (spec.unit) holder.userData.drawCat = "unit";
      else if (spec.building) holder.userData.drawCat = "building";
      const [x0, x1] = spec.gridX;
      const [y0, y1] = spec.gridY;
      const [wx0, wz0] = gridToWorld(x0, y0);
      const [wx1, wz1] = gridToWorld(x1, y1);
      holder.position.set((wx0 + wx1) / 2, 0.006, (wz0 + wz1) / 2);
      holder.add(model);
      if (spec.unit || spec.building) {
        addInteractionProxy(holder, spec, model, visualYOffset);
        // Only safe once the proxy exists to take over: the box becomes the
        // sole ray target, exactly as for enemies. Scenery has no proxy, so it
        // keeps its own raycast (nothing points at it either way).
        disableModelRaycast(model);
      }
      const entity = world
        .createTransformEntity(holder, { parent: root })
        .addComponent(ScenarioObject);
      if (spec.name === "CommandCenter") {
        boardState.commandCenter = entity;
      }
      if (spec.unit) {
        const maxHealth = currentUnitMaxHealth(spec.unit);
        entity
          .addComponent(Unit, { kind: spec.unit })
          .addComponent(UnitSelection, {
            category: spec.unitCategory ?? "command-center",
          })
          .addComponent(Health, { current: maxHealth, max: maxHealth })
          .addComponent(CombatState)
          .addComponent(RayInteractable);
        if (canUnitAttack(spec.unit)) {
          entity.addComponent(CombatCapability, { mode: "hybrid" });
        }
        if (spec.unit === "miner") {
          entity.addComponent(MinerState);
          boardState.cargoVisualByUnit.set(
            entity.index,
            addCargoVisual(holder, model, visualYOffset),
          );
          if (spec.asset === "craftMinerAnimated") {
            attachMinerAnimation(entity, model, gltf.animations);
          }
        }
        if (spec.unit === "astronaut") {
          entity.addComponent(ConstructionState);
        }
        if (spec.asset === "astronautAAnimated" || spec.asset === "craftRacer") {
          attachUnitAnimation(entity, model, gltf.animations);
        }
        attachHealthBar(holder);
      }
      if (spec.building) {
        const maxHealth = currentBuildingMaxHealth(spec.building);
        const startX = Math.round(
          (spec.gridX[0] + spec.gridX[1]) / 2 - (spec.widthTiles - 1) / 2,
        );
        const startY = Math.round(
          (spec.gridY[0] + spec.gridY[1]) / 2 - (spec.widthTiles - 1) / 2,
        );
        entity
          .addComponent(Building, {
            kind: spec.building,
            x: startX + Math.floor((spec.widthTiles - 1) / 2),
            y: startY + Math.floor((spec.widthTiles - 1) / 2),
            widthTiles: spec.widthTiles,
          })
          .addComponent(Health, { current: maxHealth, max: maxHealth })
          .addComponent(RayInteractable);
        if (spec.building === "turret") {
          entity
            .addComponent(CombatState)
            .addComponent(CombatCapability, { mode: "automatic" });
          attachTurretAnimation(entity, model, gltf.animations);
        }
        if (spec.building === "command-center") {
          attachCommandCenterAnimation(entity, model, gltf.animations);
        }
        attachHealthBar(holder);
      }
      if (spec.terrain) {
        stampTerrain(spec, spec.terrain);
      }
      if (spec.resource) {
        const x = spec.gridX[0];
        const y = spec.gridY[0];
        entity.addComponent(ResourceNode, {
          kind: spec.resource.kind,
          x,
          y,
          capacity: spec.resource.capacity,
          remaining: spec.resource.capacity,
          amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
        });
        boardState.resourceByKey.set(gridKey(x, y), entity);
      }
  }
}

export class StructuresSystem extends createSystem({}) {
  init(): void {
    createInitialScenario(this.world, { bareStart: isTutorialEnabled() });
  }
}
