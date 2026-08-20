import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  Vector3,
  createSystem,
} from "@iwsdk/core";
import { Object3D, RingGeometry } from "@iwsdk/core";
import { makeNonInteractive } from "./sharedGeometry.js";
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
  MARS_DUST_COLOR,
  MARS_DUST_OPACITY,
  MARS_DUST_SEGMENTS,
  MARS_DUST_Y_OFFSET,
  MARS_GROUND_COLOR,
  MARS_GROUND_Y_OFFSET,
  MARS_RIM_COLOR,
  MARS_RIM_THICKNESS_PER_BOARD_UNIT,
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
import {
  createMartianDustPatches,
  createMartianTerrainOutline,
  martianDustPatchPoint,
  terrainOutlineContainsBoard,
  type MartianDustPatch,
  type TerrainOutlinePoint,
} from "./martianTerrain.ts";
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

/**
 * The board's own unlit surfaces, and the colour each was authored with.
 *
 * These are `MeshBasicMaterial`, so they **ignore lights entirely** — dimming
 * the sun does nothing to them, and they are what fills the player's view. The
 * tutorial's dim therefore has to scale their colour directly.
 *
 * A small fixed set captured at build time, not a traverse of the scene: the
 * concept art's "darken everything and relight one thing" over ~800 objects is
 * a per-material pass plus a correctness problem every time something spawns.
 * Three surfaces get the same read for a hundredth of the cost.
 */
const dimmableSurfaces: { material: MeshBasicMaterial; base: Color }[] = [];
let appliedBoardDim = 1;

function registerDimmable(mesh: Mesh): void {
  const material = mesh.material as MeshBasicMaterial;
  if (!material?.color) return;
  dimmableSurfaces.push({ material, base: material.color.clone() });
}

/**
 * Scale the board's unlit surfaces toward black. `1` restores them.
 *
 * Paired with `setEnvironmentDim()`, which handles the lit GLTF models; between
 * them they cover everything the player can see. Idempotent, so it is safe to
 * call every frame.
 */
export function setBoardDim(factor: number): void {
  const clamped = Math.max(0, Math.min(1, factor));
  if (clamped === appliedBoardDim) return;
  appliedBoardDim = clamped;
  for (const entry of dimmableSurfaces) {
    entry.material.color.copy(entry.base).multiplyScalar(clamped);
  }
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
  makeNonInteractive(marker);
  marker.rotateX(-Math.PI / 2);
  marker.position.y = MARKER_Y_OFFSET;
  marker.visible = false;
  return marker;
}

function createTerrainTopGeometry(
  outline: readonly TerrainOutlinePoint[],
  y: number,
): BufferGeometry {
  const positions = [0, y, 0];
  for (const [x, z] of outline) positions.push(x, y, z);

  const indices: number[] = [];
  for (let current = 1; current <= outline.length; current += 1) {
    const next = current === outline.length ? 1 : current + 1;
    indices.push(0, next, current);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createTerrainRimGeometry(
  outline: readonly TerrainOutlinePoint[],
  topY: number,
  bottomY: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const [x, z] of outline) {
    positions.push(x, topY, z, x, bottomY, z);
  }

  for (let current = 0; current < outline.length; current += 1) {
    const next = current === outline.length - 1 ? 0 : current + 1;
    const topCurrent = current * 2;
    const bottomCurrent = topCurrent + 1;
    const topNext = next * 2;
    const bottomNext = topNext + 1;
    indices.push(
      topCurrent,
      bottomCurrent,
      topNext,
      topNext,
      bottomCurrent,
      bottomNext,
    );
  }

  // Cap the underside so the floating board never appears hollow from below.
  const bottomCenterIndex = positions.length / 3;
  positions.push(0, bottomY, 0);
  for (let current = 0; current < outline.length; current += 1) {
    const next = current === outline.length - 1 ? 0 : current + 1;
    indices.push(bottomCenterIndex, current * 2 + 1, next * 2 + 1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createDustPatchGeometry(
  patches: readonly MartianDustPatch[],
  y: number,
  segments: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const patch of patches) {
    const centerIndex = positions.length / 3;
    positions.push(patch.x, y, patch.z);
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const [x, z] = martianDustPatchPoint(patch, angle);
      positions.push(x, y, z);
    }
    for (let segment = 0; segment < segments; segment += 1) {
      const current = centerIndex + 1 + segment;
      const next = centerIndex + 1 + ((segment + 1) % segments);
      indices.push(centerIndex, next, current);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export class BoardSystem extends createSystem({}) {
  init(): void {
    const rootObject = new Group();
    rootObject.name = "BoardRoot";
    // Draw-call profiler category (frameProfiler.ts). Everything under the board
    // root inherits "static" unless its own subtree re-tags (aliens, VFX, etc.).
    rootObject.userData.drawCat = "static";
    rootObject.position.set(0, BOARD_Y, 0);
    const root = this.world.createTransformEntity(rootObject);
    boardState.boardRoot = root;

    const playableBoardSize = GRID_SIZE * TILE_SIZE;
    const rimThickness =
      playableBoardSize * MARS_RIM_THICKNESS_PER_BOARD_UNIT;
    const terrainOutline = createMartianTerrainOutline(playableBoardSize);
    if (!terrainOutlineContainsBoard(terrainOutline, playableBoardSize)) {
      throw new Error(
        "Martian terrain outline does not contain the playable board",
      );
    }

    // The dark side wall follows the irregular terrain edge and includes a
    // bottom cap. It is visual only; BoardSurface remains the square play area.
    const rim = new Mesh(
      createTerrainRimGeometry(
        terrainOutline,
        MARS_GROUND_Y_OFFSET,
        MARS_GROUND_Y_OFFSET - rimThickness,
      ),
      new MeshBasicMaterial({
        color: MARS_RIM_COLOR,
        side: DoubleSide,
      }),
    );
    makeNonInteractive(rim);
    rim.name = "BoardRim";
    registerDimmable(rim);
    this.world.createTransformEntity(rim, { parent: root });

    // One irregular dark Martian surface surrounds the square 24x24 play area.
    const ground = new Mesh(
      createTerrainTopGeometry(terrainOutline, MARS_GROUND_Y_OFFSET),
      new MeshBasicMaterial({
        color: MARS_GROUND_COLOR,
        side: DoubleSide,
      }),
    );
    makeNonInteractive(ground);
    ground.name = "BoardGround";
    registerDimmable(ground);
    this.world.createTransformEntity(ground, { parent: root });

    // Three Rocket-style ellipses are combined into one visual mesh. They sit
    // above the ground, below the command grid, and carry no interaction.
    const dustPatches = new Mesh(
      createDustPatchGeometry(
        createMartianDustPatches(playableBoardSize),
        MARS_DUST_Y_OFFSET,
        MARS_DUST_SEGMENTS,
      ),
      new MeshBasicMaterial({
        color: MARS_DUST_COLOR,
        transparent: true,
        opacity: MARS_DUST_OPACITY,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    makeNonInteractive(dustPatches);
    dustPatches.name = "BoardDustPatches";
    registerDimmable(dustPatches);
    dustPatches.renderOrder = 1;
    rootObject.add(dustPatches);

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
    gridOverlay.renderOrder = 2;
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
    makeNonInteractive(orderMesh);
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
