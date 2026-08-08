import {
  AssetManager,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RayInteractable,
  Vector3,
  type Entity,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE, gridToWorld } from "./board.js";
import type { BuildingSpec } from "./buildingCatalog.js";
import { footprintCells } from "./constructionRules.js";
import { currentBuildingMaxHealth } from "./debugStatOverrides.js";
import { attachHealthBar } from "./healthBar.js";
import { UNIT_BOX_GEOMETRY } from "./sharedGeometry.js";
import { attachTurretAnimation } from "./turretAnimation.js";
import {
  Building,
  CombatCapability,
  CombatState,
  Health,
  ScenarioObject,
  boardState,
  setTerrainAt,
} from "./state.js";

const interactionProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

export function stampBuildingFootprint(
  anchorX: number,
  anchorY: number,
  widthTiles: number,
): void {
  for (const { x, y } of footprintCells(anchorX, anchorY, widthTiles)) {
    setTerrainAt(x, y, "blocked");
  }
}

export function createBuildingEntity(
  world: World,
  parent: Entity,
  spec: BuildingSpec,
  anchorX: number,
  anchorY: number,
  name = `Built${spec.label.replace(/ /g, "")}`,
): Entity {
  const gltf = AssetManager.getGLTF(spec.asset);
  if (!gltf) throw new Error(`${spec.asset} not preloaded`);
  const model = gltf.scene;
  if (spec.yawDeg) model.rotation.y = (spec.yawDeg * Math.PI) / 180;

  const width = new Box3().setFromObject(model).getSize(new Vector3()).x;
  model.scale.setScalar((spec.widthTiles * TILE_SIZE) / width);
  seatModel(model);

  const cells = footprintCells(anchorX, anchorY, spec.widthTiles);
  const first = cells[0];
  const last = cells[cells.length - 1];
  const [wx0, wz0] = gridToWorld(first.x, first.y);
  const [wx1, wz1] = gridToWorld(last.x, last.y);
  const holder = new Group();
  holder.name = name;
  holder.userData.drawCat = "building"; // draw-call profiler category
  holder.position.set((wx0 + wx1) / 2, 0.006, (wz0 + wz1) / 2);
  holder.add(model);

  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const proxyFootprint = spec.widthTiles * TILE_SIZE * 0.86;
  const proxyHeight = Math.max(size.y, TILE_SIZE * 0.8);
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, interactionProxyMaterial);
  proxy.name = `${name}InteractionProxy`;
  proxy.scale.set(proxyFootprint, proxyHeight, proxyFootprint);
  proxy.position.y = proxyHeight / 2;
  proxy.userData.drawCat = "proxy"; // draw-call profiler category
  holder.add(proxy);

  const maxHealth = currentBuildingMaxHealth(spec.kind);
  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(Building, {
      kind: spec.kind,
      x: anchorX,
      y: anchorY,
      widthTiles: spec.widthTiles,
    })
    .addComponent(Health, { current: maxHealth, max: maxHealth })
    .addComponent(RayInteractable);
  if (spec.kind === "turret") {
    entity
      .addComponent(CombatState)
      .addComponent(CombatCapability, { mode: "automatic" });
    attachTurretAnimation(entity, model, gltf.animations);
  }
  attachHealthBar(holder);
  return entity;
}

function seatModel(model: Object3D): void {
  const box = new Box3().setFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}
