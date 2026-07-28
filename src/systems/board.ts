import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RayInteractable,
  Vector3,
  createSystem,
} from "@iwsdk/core";
import { Object3D, RingGeometry } from "@iwsdk/core";
import {
  BoardMarker,
  BoardSurface,
  DebugSettings,
  GameState,
  GameStats,
  MatchState,
  RuntimePerformance,
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
  GRID_OVERLAY_COLOR,
  GRID_OVERLAY_OPACITY,
  GRID_OVERLAY_Y_OFFSET,
  GRID_SIZE,
  HOVER_MARKER_COLOR,
  MARKER_OPACITY,
  MARKER_TILE_SCALE,
  MARKER_Y_OFFSET,
  MARS_GROUND_COLOR,
  MARS_GROUND_METALNESS,
  MARS_GROUND_ROUGHNESS,
  MARS_GROUND_Y_OFFSET,
  MARS_RIM_COLOR,
  MARS_RIM_METALNESS,
  MARS_RIM_ROUGHNESS,
  MARS_RIM_THICKNESS,
  ORDER_MARKER_COLOR,
  ORDER_MARKER_INNER_SCALE,
  ORDER_MARKER_OPACITY,
  ORDER_MARKER_OUTER_SCALE,
  ORDER_MARKER_Y_OFFSET,
  SELECTION_MARKER_COLOR,
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

    // Dark Martian rim/slab beneath the coral top gives the board visible
    // thickness and support (replaces the old rectangular BoardTable). Its top
    // sits just below the playable ground so it never intercepts pointers or
    // changes worldToGrid coordinates.
    const rim = new Mesh(
      new BoxGeometry(
        GRID_SIZE * TILE_SIZE,
        MARS_RIM_THICKNESS,
        GRID_SIZE * TILE_SIZE,
      ),
      new MeshStandardMaterial({
        color: MARS_RIM_COLOR,
        roughness: MARS_RIM_ROUGHNESS,
        metalness: MARS_RIM_METALNESS,
      }),
    );
    rim.name = "BoardRim";
    // Top face 2 mm below the coral ground to avoid coplanar z-fighting.
    rim.position.y = MARS_GROUND_Y_OFFSET - 0.002 - MARS_RIM_THICKNESS / 2;
    this.world.createTransformEntity(rim, { parent: root });

    // One continuous coral ground plane replaces the 576 terrain.glb clones.
    const ground = new Mesh(
      new PlaneGeometry(GRID_SIZE * TILE_SIZE, GRID_SIZE * TILE_SIZE),
      new MeshStandardMaterial({
        color: MARS_GROUND_COLOR,
        roughness: MARS_GROUND_ROUGHNESS,
        metalness: MARS_GROUND_METALNESS,
      }),
    );
    ground.name = "BoardGround";
    ground.rotateX(-Math.PI / 2);
    ground.position.y = MARS_GROUND_Y_OFFSET;
    this.world.createTransformEntity(ground, { parent: root });

    // Terrain is coordinate data only now — seed every cell "open" so
    // getTerrainAt/setTerrainAt keep working without per-tile entities.
    boardState.terrainByKey.clear();
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        boardState.terrainByKey.set(gridKey(x, y), "open");
      }
    }

    // Command grid overlay — one LineSegments object (not 576 squares), hidden
    // until a unit is selected. No RayInteractable: only BoardSurface handles
    // ground interaction.
    const half = (GRID_SIZE * TILE_SIZE) / 2;
    const gridVertices: number[] = [];
    for (let i = 0; i <= GRID_SIZE; i += 1) {
      const pos = -half + i * TILE_SIZE;
      gridVertices.push(-half, 0, pos, half, 0, pos); // line along X
      gridVertices.push(pos, 0, -half, pos, 0, half); // line along Z
    }
    const gridGeometry = new BufferGeometry();
    gridGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(gridVertices, 3),
    );
    const gridOverlay = new LineSegments(
      gridGeometry,
      new LineBasicMaterial({
        color: GRID_OVERLAY_COLOR,
        transparent: true,
        opacity: GRID_OVERLAY_OPACITY,
        depthWrite: false,
      }),
    );
    gridOverlay.name = "BoardCommandGrid";
    gridOverlay.position.y = GRID_OVERLAY_Y_OFFSET;
    gridOverlay.visible = false;
    boardState.gridOverlay = this.world.createTransformEntity(gridOverlay, {
      parent: root,
    });

    // One invisible board-wide volume replaces 576 per-tile ray targets.
    const boardSurface = new Mesh(
      new BoxGeometry(
        GRID_SIZE * TILE_SIZE,
        TILE_PROXY_HEIGHT,
        GRID_SIZE * TILE_SIZE,
      ),
      new MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
      }),
    );
    boardSurface.name = "BoardInteractionSurface";
    boardSurface.position.y = TILE_PROXY_Y_OFFSET;
    const localHit = new Vector3();
    const updatePointerTile = (event: { point: Vector3 }): void => {
      localHit.copy(event.point);
      rootObject.worldToLocal(localHit);
      const [x, y] = worldToGrid(localHit.x, localHit.z);
      boardState.pointerTile =
        x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE ? { x, y } : null;
    };
    const clearPointerTile = (): void => {
      boardState.pointerTile = null;
    };
    boardSurface.addEventListener("pointermove", updatePointerTile);
    boardSurface.addEventListener("pointerdown", updatePointerTile);
    boardSurface.addEventListener("pointerleave", clearPointerTile);
    this.cleanupFuncs.push(() => {
      boardSurface.removeEventListener("pointermove", updatePointerTile);
      boardSurface.removeEventListener("pointerdown", updatePointerTile);
      boardSurface.removeEventListener("pointerleave", clearPointerTile);
    });
    boardState.boardSurface = this.world
      .createTransformEntity(boardSurface, { parent: root })
      .addComponent(BoardSurface)
      .addComponent(RayInteractable);

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

    const performanceObject = new Object3D();
    performanceObject.name = "RuntimePerformance";
    boardState.runtimePerformance = this.world
      .createTransformEntity(performanceObject, { parent: root })
      .addComponent(RuntimePerformance);

    const waveSourceObject = new Object3D();
    waveSourceObject.name = "WaveSource";
    boardState.waveSource = this.world
      .createTransformEntity(waveSourceObject, { parent: root })
      .addComponent(WaveSource)
      .addComponent(MatchState);

    const debugSettingsObject = new Object3D();
    debugSettingsObject.name = "DebugSettings";
    boardState.debugSettings = this.world
      .createTransformEntity(debugSettingsObject, { parent: root })
      .addComponent(DebugSettings);
  }
}
