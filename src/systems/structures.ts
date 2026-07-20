import {
  AssetManager,
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RayInteractable,
  Vector3,
  createSystem,
} from "@iwsdk/core";
import { TILE_SIZE, gridToWorld } from "./board.js";
import { BoardTile, Enemy, Unit, boardState, gridKey } from "./state.js";

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
  /** enemy: attaches Enemy {kind} + RayInteractable (approach/attack target) */
  enemy?: string;
  /** stamps the tiles under the footprint: "crystal" (minable) | "blocked" */
  terrain?: string;
}

const STRUCTURES: StructureSpec[] = [
  // 15m-wide model scaled onto 3x3 tiles, board center (tiles 10-12).
  { asset: "commandCenter", name: "CommandCenter", widthTiles: 3, gridX: [11, 11], gridY: [11, 11], terrain: "blocked" },
  // 2x3m hangar onto 2x3 tiles, left of center with a one-tile gap.
  { asset: "hangarLargeA", name: "Hangar", widthTiles: 2, gridX: [7, 8], gridY: [11, 11], terrain: "blocked" },
  // Aircraft factory onto 3x3 tiles (tiles 14-16), right of center with a
  // one-tile gap. Vertex-hull measurement confirms the base is axis-aligned.
  { asset: "aircraft_factory", name: "AircraftFactory", widthTiles: 3, gridX: [15, 15], gridY: [11, 11], terrain: "blocked" },

  // Crystal field A — front-left, close to the base cluster (early mining).
  { asset: "rockCrystalsLargeA", name: "CrystalLargeA", widthTiles: 1, gridX: [5, 5], gridY: [16, 16], terrain: "crystal" },
  { asset: "rockCrystals", name: "CrystalSmallA", widthTiles: 1, gridX: [6, 6], gridY: [17, 17], terrain: "crystal" },
  { asset: "rocksSmallB", name: "RocksSmallB", widthTiles: 1, gridX: [4, 4], gridY: [17, 17], terrain: "blocked" },
  // Crystal field B — back-right expansion.
  { asset: "rockCrystalsLargeB", name: "CrystalLargeB", widthTiles: 1, gridX: [18, 18], gridY: [6, 6], terrain: "crystal" },
  { asset: "rockCrystals", name: "CrystalSmallB", widthTiles: 1, gridX: [19, 19], gridY: [7, 7], terrain: "crystal" },
  // Crystal field expansions.
  { asset: "rockCrystalsLargeB", name: "CrystalA3", widthTiles: 1, gridX: [4, 4], gridY: [15, 15], terrain: "crystal" },
  { asset: "rockCrystals", name: "CrystalA4", widthTiles: 1, gridX: [5, 5], gridY: [18, 18], yawDeg: 90, terrain: "crystal" },
  { asset: "rockCrystalsLargeA", name: "CrystalB3", widthTiles: 1, gridX: [17, 17], gridY: [5, 5], yawDeg: 180, terrain: "crystal" },
  { asset: "rockCrystals", name: "CrystalB4", widthTiles: 1, gridX: [20, 20], gridY: [6, 6], yawDeg: 90, terrain: "crystal" },
  // Crystal field C — front-right pocket.
  { asset: "rockCrystalsLargeB", name: "CrystalC1", widthTiles: 1, gridX: [19, 19], gridY: [17, 17], yawDeg: 270, terrain: "crystal" },
  { asset: "rockCrystals", name: "CrystalC2", widthTiles: 1, gridX: [20, 20], gridY: [16, 16], terrain: "crystal" },

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
  { asset: "astronautA", name: "AstronautA", widthTiles: 1, gridX: [9, 9], gridY: [12, 12], yawDeg: 180, unit: "astronaut" },
  { asset: "astronautB", name: "AstronautB", widthTiles: 1, gridX: [13, 13], gridY: [12, 12], yawDeg: 180, unit: "astronaut" },

  // Aliens use live occupancy instead of stamped terrain so their old tile
  // automatically becomes open when wave movement is added.
  { asset: "alien", name: "Alien1", widthTiles: 1, gridX: [1, 1], gridY: [1, 1], yawDeg: 180, enemy: "alien" },
  { asset: "alien", name: "Alien2", widthTiles: 1, gridX: [6, 6], gridY: [0, 0], yawDeg: 180, enemy: "alien" },
  { asset: "alien", name: "Alien3", widthTiles: 1, gridX: [12, 12], gridY: [1, 1], yawDeg: 180, enemy: "alien" },
  { asset: "alien", name: "Alien4", widthTiles: 1, gridX: [18, 18], gridY: [0, 0], yawDeg: 180, enemy: "alien" },
  { asset: "alien", name: "Alien5", widthTiles: 1, gridX: [22, 22], gridY: [1, 1], yawDeg: 180, enemy: "alien" },
  { asset: "alien", name: "Alien6", widthTiles: 1, gridX: [23, 23], gridY: [8, 8], yawDeg: 270, enemy: "alien" },
  { asset: "alien", name: "Alien7", widthTiles: 1, gridX: [22, 22], gridY: [15, 15], yawDeg: 270, enemy: "alien" },
  { asset: "alien", name: "Alien8", widthTiles: 1, gridX: [21, 21], gridY: [22, 22], enemy: "alien" },
  { asset: "alien", name: "Alien9", widthTiles: 1, gridX: [12, 12], gridY: [22, 22], enemy: "alien" },
  { asset: "alien", name: "Alien10", widthTiles: 1, gridX: [3, 3], gridY: [22, 22], enemy: "alien" },

  // Craft — the fleet lined up in front of the command center.
  { asset: "rover", name: "Rover", widthTiles: 1, gridX: [10, 10], gridY: [13, 13], yawDeg: 180, unit: "rover" },
  { asset: "craftMiner", name: "CraftMiner", widthTiles: 1, gridX: [11, 11], gridY: [13, 13], yawDeg: 180, unit: "miner" },
  { asset: "craftCargoA", name: "CraftCargo", widthTiles: 1, gridX: [12, 12], gridY: [13, 13], yawDeg: 180, unit: "cargo" },
  { asset: "craftRacer", name: "CraftRacer", widthTiles: 1, gridX: [13, 13], gridY: [13, 13], yawDeg: 180, unit: "racer" },

  // Base defense — turret guarding the southwest approach.
  { asset: "turretSingle", name: "TurretSingle", widthTiles: 1, gridX: [9, 9], gridY: [14, 14], yawDeg: 180, terrain: "blocked" },

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
function stampTerrain(spec: StructureSpec, terrain: string): void {
  const w = spec.widthTiles;
  const startX = Math.round((spec.gridX[0] + spec.gridX[1]) / 2 - (w - 1) / 2);
  const startY = Math.round((spec.gridY[0] + spec.gridY[1]) / 2 - (w - 1) / 2);
  for (let y = startY; y < startY + w; y += 1) {
    for (let x = startX; x < startX + w; x += 1) {
      boardState.tileByKey.get(gridKey(x, y))?.setValue(BoardTile, "terrain", terrain);
    }
  }
}

function seatModel(model: Object3D): void {
  const box = new Box3().setFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}

const interactionProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

function addInteractionProxy(holder: Group, spec: StructureSpec, model: Object3D): void {
  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const footprint = spec.widthTiles * TILE_SIZE * 0.82;
  const height = Math.max(size.y, TILE_SIZE * 0.8);
  const proxy = new Mesh(
    new BoxGeometry(footprint, height, footprint),
    interactionProxyMaterial,
  );
  proxy.name = `${spec.name}InteractionProxy`;
  proxy.position.y = height / 2;
  holder.add(proxy);
}

export class StructuresSystem extends createSystem({}) {
  init(): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("StructuresSystem requires BoardSystem first");

    for (const spec of STRUCTURES) {
      const gltf = AssetManager.getGLTF(spec.asset);
      if (!gltf) throw new Error(`${spec.asset} not preloaded`);
      const model = gltf.scene;

      // Rotate BEFORE measuring/seating so bounds reflect the final pose.
      if (spec.yawDeg) model.rotation.y = (spec.yawDeg * Math.PI) / 180;

      const width = new Box3().setFromObject(model).getSize(new Vector3()).x;
      const scale = (spec.widthTiles * TILE_SIZE) / width;
      model.scale.setScalar(scale);
      seatModel(model);

      const holder = new Group();
      holder.name = spec.name;
      const [x0, x1] = spec.gridX;
      const [y0, y1] = spec.gridY;
      const [wx0, wz0] = gridToWorld(x0, y0);
      const [wx1, wz1] = gridToWorld(x1, y1);
      holder.position.set((wx0 + wx1) / 2, 0.006, (wz0 + wz1) / 2);
      holder.add(model);
      if (spec.unit || spec.enemy) {
        addInteractionProxy(holder, spec, model);
      }
      const entity = this.world.createTransformEntity(holder, { parent: root });
      if (spec.unit) {
        entity
          .addComponent(Unit, { kind: spec.unit })
          .addComponent(RayInteractable);
      }
      if (spec.enemy) {
        entity
          .addComponent(Enemy, { kind: spec.enemy })
          .addComponent(RayInteractable);
      }
      if (spec.terrain) {
        stampTerrain(spec, spec.terrain);
      }
    }
  }
}
