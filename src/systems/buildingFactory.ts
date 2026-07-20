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
import type { BuildingSpec } from "./buildingCatalog.js";
import { footprintCells } from "./constructionRules.js";
import { BoardTile, Building, boardState, gridKey } from "./state.js";

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
    boardState.tileByKey.get(gridKey(x, y))?.setValue(
      BoardTile,
      "terrain",
      "blocked",
    );
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
  holder.position.set((wx0 + wx1) / 2, 0.006, (wz0 + wz1) / 2);
  holder.add(model);

  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const proxy = new Mesh(
    new BoxGeometry(
      spec.widthTiles * TILE_SIZE * 0.86,
      Math.max(size.y, TILE_SIZE * 0.8),
      spec.widthTiles * TILE_SIZE * 0.86,
    ),
    interactionProxyMaterial,
  );
  proxy.name = `${name}InteractionProxy`;
  proxy.position.y = Math.max(size.y, TILE_SIZE * 0.8) / 2;
  holder.add(proxy);

  return world
    .createTransformEntity(holder, { parent })
    .addComponent(Building, {
      kind: spec.kind,
      x: anchorX,
      y: anchorY,
      widthTiles: spec.widthTiles,
    })
    .addComponent(RayInteractable);
}

function seatModel(model: Object3D): void {
  const box = new Box3().setFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}
