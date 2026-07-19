import {
  AssetManager,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RayInteractable,
  createSystem,
} from "@iwsdk/core";
import { BoardMarker, BoardTile, boardState } from "./state.js";

export const GRID_SIZE = 24;
export const TILE_SIZE = 0.18;
export const BOARD_Y = 0.78;

export function gridToWorld(x: number, y: number): [number, number] {
  const offset = (GRID_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2;
  return [x * TILE_SIZE - offset, y * TILE_SIZE - offset];
}

function makeMarker(color: number): Mesh {
  const marker = new Mesh(
    new PlaneGeometry(TILE_SIZE * 1.08, TILE_SIZE * 1.08),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  );
  marker.rotateX(-Math.PI / 2);
  marker.position.y = 0.023;
  marker.visible = false;
  return marker;
}

export class BoardSystem extends createSystem({}) {
  init(): void {
    this.world.scene.background = new Color(0xb8d8f1);

    const rootObject = new Group();
    rootObject.name = "BoardRoot";
    rootObject.position.set(0, BOARD_Y, 0);
    const root = this.world.createTransformEntity(rootObject);
    boardState.boardRoot = root;

    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(2.5, 4, 3);
    sun.name = "BoardSun";
    this.world.createTransformEntity(sun, { parent: root });

    const table = new Mesh(
      new BoxGeometry(
        GRID_SIZE * TILE_SIZE + 0.45,
        0.12,
        GRID_SIZE * TILE_SIZE + 0.45,
      ),
      new MeshStandardMaterial({
        color: 0x5a4a36,
        roughness: 0.8,
        metalness: 0.05,
      }),
    );
    table.name = "BoardTable";
    table.position.y = -0.08;
    this.world.createTransformEntity(table, { parent: root });

    // The terrain.glb tile is a zero-thickness plane; give each tile a thin
    // invisible box so the ray BVH has a volume to hit.
    const proxyGeometry = new BoxGeometry(1, 0.06, 1);
    const proxyMaterial = new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
    });
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const gltf = AssetManager.getGLTF("terrain");
        if (!gltf) throw new Error("terrain.glb not preloaded");
        const tile = gltf.scene;
        // The GLB's node carries a baked (2, 0, 1.5) pivot offset — re-center
        // so the drawn tile, raycast proxy, and marker math all agree.
        tile.children.forEach((child) => child.position.set(0, 0, 0));
        tile.name = `Tile_${x}_${y}`;
        const [worldX, worldZ] = gridToWorld(x, y);
        tile.position.set(worldX, 0, worldZ);
        tile.scale.setScalar(TILE_SIZE * 0.96);
        const proxy = new Mesh(proxyGeometry, proxyMaterial);
        proxy.position.y = 0.03;
        tile.add(proxy);
        this.world
          .createTransformEntity(tile, { parent: root })
          .addComponent(BoardTile, { x, y })
          .addComponent(RayInteractable);
      }
    }

    const hoverMesh = makeMarker(0xfacc15);
    hoverMesh.name = "BoardHoverMarker";
    boardState.hoverMarker = this.world
      .createTransformEntity(hoverMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "hover" });

    const selectionMesh = makeMarker(0x38bdf8);
    selectionMesh.name = "BoardSelectionMarker";
    boardState.selectionMarker = this.world
      .createTransformEntity(selectionMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "selection" });
  }
}
