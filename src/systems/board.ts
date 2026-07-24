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
import { Object3D, RingGeometry } from "@iwsdk/core";
import {
  BoardMarker,
  BoardTile,
  GameState,
  GameStats,
  MatchState,
  SelectionState,
  WaveSource,
  boardState,
  gridKey,
} from "./state.js";
import {
  BOARD_BACKGROUND_COLOR,
  BOARD_SUN_COLOR,
  BOARD_SUN_INTENSITY,
  BOARD_SUN_POSITION,
  BOARD_Y,
  BUILD_MARKER_OPACITY,
  BUILD_MARKER_COLOR,
  GRID_SIZE,
  HOVER_MARKER_COLOR,
  MARKER_OPACITY,
  MARKER_TILE_SCALE,
  MARKER_Y_OFFSET,
  ORDER_MARKER_COLOR,
  ORDER_MARKER_INNER_SCALE,
  ORDER_MARKER_OPACITY,
  ORDER_MARKER_OUTER_SCALE,
  ORDER_MARKER_Y_OFFSET,
  SELECTION_MARKER_COLOR,
  TABLE_COLOR,
  TABLE_EDGE_PADDING,
  TABLE_METALNESS,
  TABLE_ROUGHNESS,
  TABLE_THICKNESS,
  TABLE_Y_OFFSET,
  TERRAIN_TILE_SCALE,
  TILE_SIZE,
  TILE_PROXY_HEIGHT,
  TILE_PROXY_Y_OFFSET,
} from "./constants.ts";
export { BOARD_Y, GRID_SIZE, TILE_SIZE } from "./constants.ts";

export function gridToWorld(x: number, y: number): [number, number] {
  const offset = (GRID_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2;
  return [x * TILE_SIZE - offset, y * TILE_SIZE - offset];
}

export function worldToGrid(localX: number, localZ: number): [number, number] {
  const offset = (GRID_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2;
  return [
    Math.round((localX + offset) / TILE_SIZE),
    Math.round((localZ + offset) / TILE_SIZE),
  ];
}

function makeMarker(color: number): Mesh {
  const marker = new Mesh(
    new PlaneGeometry(TILE_SIZE * MARKER_TILE_SCALE, TILE_SIZE * MARKER_TILE_SCALE),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: MARKER_OPACITY,
      depthWrite: false,
    }),
  );
  marker.rotateX(-Math.PI / 2);
  marker.position.y = MARKER_Y_OFFSET;
  marker.visible = false;
  return marker;
}

export class BoardSystem extends createSystem({}) {
  init(): void {
    this.world.scene.background = new Color(BOARD_BACKGROUND_COLOR);

    const rootObject = new Group();
    rootObject.name = "BoardRoot";
    rootObject.position.set(0, BOARD_Y, 0);
    const root = this.world.createTransformEntity(rootObject);
    boardState.boardRoot = root;

    const sun = new DirectionalLight(BOARD_SUN_COLOR, BOARD_SUN_INTENSITY);
    sun.position.set(...BOARD_SUN_POSITION);
    sun.name = "BoardSun";
    this.world.createTransformEntity(sun, { parent: root });

    const table = new Mesh(
      new BoxGeometry(
        GRID_SIZE * TILE_SIZE + TABLE_EDGE_PADDING,
        TABLE_THICKNESS,
        GRID_SIZE * TILE_SIZE + TABLE_EDGE_PADDING,
      ),
      new MeshStandardMaterial({
        color: TABLE_COLOR,
        roughness: TABLE_ROUGHNESS,
        metalness: TABLE_METALNESS,
      }),
    );
    table.name = "BoardTable";
    table.position.y = TABLE_Y_OFFSET;
    this.world.createTransformEntity(table, { parent: root });

    // The terrain.glb tile is a zero-thickness plane; give each tile a thin
    // invisible box so the ray BVH has a volume to hit.
    const proxyGeometry = new BoxGeometry(1, TILE_PROXY_HEIGHT, 1);
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
        tile.scale.setScalar(TILE_SIZE * TERRAIN_TILE_SCALE);
        const proxy = new Mesh(proxyGeometry, proxyMaterial);
        proxy.position.y = TILE_PROXY_Y_OFFSET;
        tile.add(proxy);
        const tileEntity = this.world
          .createTransformEntity(tile, { parent: root })
          .addComponent(BoardTile, { x, y })
          .addComponent(RayInteractable);
        boardState.tileByKey.set(gridKey(x, y), tileEntity);
      }
    }

    const hoverMesh = makeMarker(HOVER_MARKER_COLOR);
    hoverMesh.name = "BoardHoverMarker";
    boardState.hoverMarker = this.world
      .createTransformEntity(hoverMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "hover" });

    const selectionMesh = makeMarker(SELECTION_MARKER_COLOR);
    selectionMesh.name = "BoardSelectionMarker";
    boardState.selectionMarker = this.world
      .createTransformEntity(selectionMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "selection" });

    // Order marker — an orange ring at an accepted move destination.
    const orderMesh = new Mesh(
      new RingGeometry(
        TILE_SIZE * ORDER_MARKER_INNER_SCALE,
        TILE_SIZE * ORDER_MARKER_OUTER_SCALE,
        32,
      ),
      new MeshBasicMaterial({
        color: ORDER_MARKER_COLOR,
        transparent: true,
        opacity: ORDER_MARKER_OPACITY,
        depthWrite: false,
      }),
    );
    orderMesh.name = "BoardOrderMarker";
    orderMesh.rotateX(-Math.PI / 2);
    orderMesh.position.y = ORDER_MARKER_Y_OFFSET;
    orderMesh.visible = false;
    boardState.orderMarker = this.world
      .createTransformEntity(orderMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "order" });

    const buildMesh = makeMarker(BUILD_MARKER_COLOR);
    buildMesh.name = "BoardBuildFootprintMarker";
    (buildMesh.material as MeshBasicMaterial).opacity = BUILD_MARKER_OPACITY;
    boardState.buildMarker = this.world
      .createTransformEntity(buildMesh, { parent: root })
      .addComponent(BoardMarker, { kind: "build" });

    // ECS-visible selection singleton.
    const selectionObject = new Object3D();
    selectionObject.name = "SelectionState";
    boardState.selection = this.world
      .createTransformEntity(selectionObject, { parent: root })
      .addComponent(SelectionState);

    const gameStateObject = new Object3D();
    gameStateObject.name = "GameState";
    boardState.gameState = this.world
      .createTransformEntity(gameStateObject, { parent: root })
      .addComponent(GameState);

    const statsObject = new Object3D();
    statsObject.name = "GameStats";
    boardState.gameStats = this.world
      .createTransformEntity(statsObject, { parent: root })
      .addComponent(GameStats);

    const waveSourceObject = new Object3D();
    waveSourceObject.name = "WaveSource";
    boardState.waveSource = this.world
      .createTransformEntity(waveSourceObject, { parent: root })
      .addComponent(WaveSource)
      .addComponent(MatchState);
  }
}
