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
  type Entity,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE, gridToWorld } from "./board.js";
import type { CraftSpec } from "./craftCatalog.js";
import { MinerState, Unit, boardState } from "./state.js";

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
): Entity {
  const gltf = AssetManager.getGLTF(spec.asset);
  if (!gltf) throw new Error(`${spec.asset} not preloaded`);
  const model = gltf.scene;
  model.rotation.y = Math.PI;
  const width = new Box3().setFromObject(model).getSize(new Vector3()).x;
  model.scale.setScalar((TILE_SIZE * 0.9) / width);
  seatModel(model);

  const holder = new Group();
  craftSerial += 1;
  holder.name = `Produced${spec.label.replace(/ /g, "")}_${craftSerial}`;
  const [worldX, worldZ] = gridToWorld(x, y);
  holder.position.set(worldX, 0.006, worldZ);
  holder.add(model);

  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const proxy = new Mesh(
    new BoxGeometry(
      TILE_SIZE * 0.82,
      Math.max(size.y, TILE_SIZE * 0.8),
      TILE_SIZE * 0.82,
    ),
    interactionProxyMaterial,
  );
  proxy.name = `${holder.name}InteractionProxy`;
  proxy.position.y = Math.max(size.y, TILE_SIZE * 0.8) / 2;
  holder.add(proxy);

  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(Unit, { kind: spec.kind })
    .addComponent(RayInteractable);
  if (spec.kind === "miner") {
    entity.addComponent(MinerState);
    boardState.cargoVisualByUnit.set(
      entity.index,
      addMinerCargoVisual(holder, model),
    );
  }
  return entity;
}

function addMinerCargoVisual(holder: Group, model: Object3D): Object3D {
  const cargo = AssetManager.getGLTF("rockCrystals")?.scene;
  if (!cargo) throw new Error("rockCrystals not preloaded for miner cargo");
  const cargoWidth = new Box3().setFromObject(cargo).getSize(new Vector3()).x;
  cargo.scale.setScalar((TILE_SIZE * 0.3) / cargoWidth);
  seatModel(cargo);
  const modelHeight = new Box3().setFromObject(model).getSize(new Vector3()).y;
  cargo.name = "MinerCargoVisual";
  cargo.position.y = modelHeight + TILE_SIZE * 0.04;
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
