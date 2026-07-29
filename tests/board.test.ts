import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GRID_SIZE, TILE_SIZE } from "../src/systems/constants.ts";
import {
  createMartianTerrainOutline,
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

test("board renders one continuous irregular coral ground", () => {
  assert.ok(board.includes('name = "BoardGround"'));
  assert.ok(board.includes("MARS_GROUND_COLOR"));
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

test("grid visibility follows unit selection", () => {
  assert.ok(
    selection.includes("boardState.gridOverlay"),
    "selection must control the grid overlay",
  );
  assert.ok(
    selection.includes("boardState.selectedUnits.size > 0"),
    "grid is shown while any unit is selected",
  );
});

test("terrain GLB is removed from the asset manifest", () => {
  assert.ok(
    !index.includes("terrain.glb"),
    "the terrain GLB is no longer used and must leave the manifest",
  );
});
