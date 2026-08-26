import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GRID_SIZE,
  MARS_DUST_SEGMENTS,
  MARS_GROUND_COLOR,
  MARS_RIM_THICKNESS_PER_BOARD_UNIT,
  TILE_SIZE,
} from "../src/systems/constants.ts";
import {
  createMartianDustPatches,
  createMartianTerrainOutline,
  martianDustPatchPoint,
  terrainOutlineContainsBoard,
  terrainOutlineContainsPoint,
} from "../src/systems/martianTerrain.ts";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

const board = source("src/systems/board.ts");
const selection = source("src/systems/selection.ts");
const index = source("src/index.ts");

test("board no longer clones 576 terrain tiles", () => {
  assert.ok(
    !board.includes("terrain.scene.clone"),
    "the per-tile terrain clone loop must be gone",
  );
  assert.ok(
    !board.includes('getGLTF("terrain")'),
    "board must not load the terrain GLB",
  );
  assert.ok(
    !board.includes("BoardTileVisuals"),
    "the 576-tile visual group must be gone",
  );
});

test("board renders one continuous irregular dark Martian ground", () => {
  assert.ok(board.includes('name = "BoardGround"'));
  assert.ok(board.includes("MARS_GROUND_COLOR"));
  assert.equal(MARS_GROUND_COLOR, 0xa85d43);
  assert.ok(
    board.includes(
      "createTerrainTopGeometry(terrainOutline, MARS_GROUND_Y_OFFSET)",
    ),
    "ground must use the Rocket-style terrain outline",
  );
});

test("board adds an outline-following capped rim and no rectangular table", () => {
  assert.ok(board.includes('name = "BoardRim"'));
  assert.ok(board.includes("MARS_RIM_COLOR"));
  assert.ok(board.includes("createTerrainRimGeometry("));
  assert.ok(
    board.includes("bottomCenterIndex"),
    "rim geometry must cap the underside",
  );
  assert.ok(
    !board.includes('name = "BoardTable"'),
    "the old table mesh must be removed",
  );
  assert.ok(
    !board.includes("TABLE_COLOR"),
    "table material constants must be gone from board",
  );
});

test("irregular terrain contains the playable square and scales with it", () => {
  for (const gridSize of [GRID_SIZE, 32]) {
    const boardSize = gridSize * TILE_SIZE;
    const half = boardSize / 2;
    const outline = createMartianTerrainOutline(boardSize);

    assert.equal(terrainOutlineContainsBoard(outline, boardSize), true);
    assert.equal(terrainOutlineContainsPoint(outline, 0, 0), true);
    assert.ok(outline.some(([x]) => x < -half));
    assert.ok(outline.some(([x]) => x > half));
    assert.ok(outline.some(([, z]) => z < -half));
    assert.ok(outline.some(([, z]) => z > half));
  }
});

test("board combines three scalable dust patches below the command grid", () => {
  for (const gridSize of [GRID_SIZE, 32]) {
    const boardSize = gridSize * TILE_SIZE;
    const outline = createMartianTerrainOutline(boardSize);
    const patches = createMartianDustPatches(boardSize);
    assert.equal(patches.length, 3);

    for (const patch of patches) {
      for (let segment = 0; segment < MARS_DUST_SEGMENTS; segment += 1) {
        const angle = (segment / MARS_DUST_SEGMENTS) * Math.PI * 2;
        const [x, z] = martianDustPatchPoint(patch, angle);
        assert.equal(terrainOutlineContainsPoint(outline, x, z), true);
      }
    }
  }

  assert.ok(board.includes('name = "BoardDustPatches"'));
  assert.ok(board.includes("createDustPatchGeometry("));
  assert.ok(board.includes("rootObject.add(dustPatches)"));
  assert.ok(board.includes("dustPatches.renderOrder = 1"));
  assert.ok(board.includes("gridOverlay.renderOrder = 2"));
});

test("board keeps terrain colors independent from gameplay lighting", () => {
  assert.ok(index.includes("defaultLighting: true"));
  assert.equal(board.includes("new HemisphereLight("), false);
  assert.equal(board.includes("new DirectionalLight("), false);
  assert.ok(
    board.includes(`new MeshBasicMaterial({
        color: MARS_RIM_COLOR,`),
  );
  assert.ok(
    board.includes(`new MeshBasicMaterial({
        color: MARS_GROUND_COLOR,`),
  );
  assert.equal(board.includes("new MeshStandardMaterial("), false);
  assert.ok(
    board.includes(
      "playableBoardSize * MARS_RIM_THICKNESS_PER_BOARD_UNIT",
    ),
  );
  const rimThickness =
    GRID_SIZE * TILE_SIZE * MARS_RIM_THICKNESS_PER_BOARD_UNIT;
  assert.ok(Math.abs(rimThickness - 0.601344) < 1e-9);
});

test("board creates exactly one command grid overlay, hidden by default", () => {
  assert.ok(board.includes('name = "BoardCommandGrid"'));
  assert.ok(board.includes("new LineSegments("), "grid is one LineSegments object");
  assert.ok(board.includes("boardState.gridOverlay = "));
  assert.ok(
    board.includes("gridOverlay.visible = false"),
    "grid must start hidden",
  );
});

test("BoardSurface is the only ground RayInteractable", () => {
  const rayInteractableCount = (
    board.match(/\.addComponent\(RayInteractable\)/g) ?? []
  ).length;
  assert.equal(
    rayInteractableCount,
    1,
    "board.ts must add RayInteractable exactly once (the interaction surface)",
  );
  assert.ok(board.includes('name = "BoardInteractionSurface"'));
});

test("grid visibility follows selection and placement modes", () => {
  assert.ok(
    selection.includes("boardState.gridOverlay"),
    "selection must control the grid overlay",
  );
  // The selected-unit count was lifted into a local so the [GridVisual] edge
  // log can report it alongside the decision. Assert the read and the disjunct
  // separately rather than one inline expression, so naming the value does not
  // fail a test about behaviour.
  assert.ok(
    selection.includes("boardState.selectedUnits.size"),
    "selection must read the selected-unit count",
  );
  assert.ok(
    selection.includes("selectedUnits > 0"),
    "grid is shown while any unit is selected",
  );
  assert.ok(
    selection.includes("Boolean(boardState.selectedTurret)"),
    "grid is shown while a turret is selected",
  );
  assert.ok(
    selection.includes("buildPlacementActive") &&
      selection.includes("craftPlacementActive"),
    "grid is shown while build or craft placement is active",
  );
});

test("terrain GLB is removed from the asset manifest", () => {
  assert.ok(
    !index.includes("terrain.glb"),
    "the terrain GLB is no longer used and must leave the manifest",
  );
});
