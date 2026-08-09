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
import { canUnitAttack } from "./combatRules.js";
import { CRAFT_VISUAL_ELEVATION } from "./constants.ts";
import type { CraftSpec } from "./craftCatalog.js";
import { attachCraftVisualRise } from "./craftVisualRise.js";
import { currentUnitMaxHealth } from "./debugStatOverrides.js";
import { attachHealthBar } from "./healthBar.js";
import { UNIT_BOX_GEOMETRY } from "./sharedGeometry.js";
import { disableModelRaycast } from "./structures.js";
import { attachMinerAnimation } from "./minerAnimation.js";
import { attachUnitAnimation } from "./unitAnimation.js";
import {
  CombatState,
  CombatCapability,
  Health,
  ConstructionState,
  MinerState,
  ScenarioObject,
  Unit,
  UnitSelection,
  boardState,
} from "./state.js";

const interactionProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});
let craftSerial = 0;

export function createCraftEntity(
  world: World,
  parent: Entity,
  spec: CraftSpec,
  x: number,
  y: number,
  category: string,
): Entity {
  const gltf = AssetManager.getGLTF(spec.asset);
  if (!gltf) throw new Error(`${spec.asset} not preloaded`);
  const model = gltf.scene;
  model.rotation.y = Math.PI;
  const width = new Box3().setFromObject(model).getSize(new Vector3()).x;
  model.scale.setScalar((TILE_SIZE * 0.9) / width);
  seatModel(model);
  const visualYOffset = craftVisualElevation(spec);
  const seatedModelY = model.position.y;
  const elevatedModelY = seatedModelY + visualYOffset;
  model.position.y = elevatedModelY;

  const holder = new Group();
  craftSerial += 1;
  holder.name = `Produced${spec.label.replace(/ /g, "")}_${craftSerial}`;
  holder.userData.drawCat = "unit"; // draw-call profiler category
  const [worldX, worldZ] = gridToWorld(x, y);
  holder.position.set(worldX, 0.006, worldZ);
  holder.add(model);
  // The box proxy below is the sole ray target, as for enemies. Without
  // this the whole model hierarchy is hit-tested every frame, both hands.
  disableModelRaycast(model);

  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const proxyHeight = Math.max(size.y + visualYOffset, TILE_SIZE * 0.8);
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, interactionProxyMaterial);
  proxy.name = `${holder.name}InteractionProxy`;
  proxy.scale.set(TILE_SIZE * 0.82, proxyHeight, TILE_SIZE * 0.82);
  proxy.position.y = proxyHeight / 2;
  proxy.userData.drawCat = "proxy"; // draw-call profiler category
  holder.add(proxy);

  const maxHealth = currentUnitMaxHealth(spec.kind);
  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(Unit, { kind: spec.kind })
    .addComponent(UnitSelection, { category })
    .addComponent(Health, { current: maxHealth, max: maxHealth })
    .addComponent(CombatState)
    .addComponent(RayInteractable);
  if (canUnitAttack(spec.kind)) {
    entity.addComponent(CombatCapability, { mode: "hybrid" });
  }
  if (spec.kind === "miner") {
    entity.addComponent(MinerState);
    boardState.cargoVisualByUnit.set(
      entity.index,
      addMinerCargoVisual(holder, model, visualYOffset),
    );
    if (spec.asset === "craftMinerAnimated") {
      attachMinerAnimation(entity, model, gltf.animations);
    }
  }
  if (spec.kind === "astronaut") {
    entity.addComponent(ConstructionState);
  }
  if (spec.asset === "astronautAAnimated" || spec.asset === "craftRacer") {
    attachUnitAnimation(entity, model, gltf.animations);
  }
  attachHealthBar(holder);
  if (visualYOffset > 0) {
    model.position.y = seatedModelY;
    attachCraftVisualRise(entity, model, elevatedModelY);
  }
  return entity;
}

export function resetCraftSerial(): void {
  craftSerial = 0;
}

function craftVisualElevation(spec: CraftSpec): number {
  return spec.kind === "cargo" || spec.kind === "racer"
    ? CRAFT_VISUAL_ELEVATION
    : 0;
}

function addMinerCargoVisual(
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

function seatModel(model: Object3D): void {
  const box = new Box3().setFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}
