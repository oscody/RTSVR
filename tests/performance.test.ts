import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolvePerformanceSample } from "../src/systems/performanceRules.ts";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("performance samples report a 72 Hz frame budget", () => {
  const sample = resolvePerformanceSample(1, 72, 1 / 60);

  assert.equal(sample.fps, 72);
  assert.ok(Math.abs(sample.averageFrameMs - 13.8889) < 0.001);
  assert.ok(Math.abs(sample.worstFrameMs - 16.6667) < 0.001);
});

test("XR runtime code does not schedule its own animation frame loop", () => {
  const runtimeFiles = [
    "src/index.ts",
    "src/systems/alienAnimation.ts",
    "src/systems/commandCenterAnimation.ts",
    "src/systems/minerAnimation.ts",
    "src/systems/tablet.ts",
    "src/systems/turretAnimation.ts",
    "src/systems/unitAnimation.ts",
    "src/systems/wave.ts",
  ];

  for (const file of runtimeFiles) {
    assert.doesNotMatch(source(file), /requestAnimationFrame/);
  }
});

test("hot animation systems reuse their live-controller sets", () => {
  const animationFiles = [
    "src/systems/alienAnimation.ts",
    "src/systems/commandCenterAnimation.ts",
    "src/systems/minerAnimation.ts",
    "src/systems/turretAnimation.ts",
    "src/systems/unitAnimation.ts",
  ];

  for (const file of animationFiles) {
    const code = source(file);
    assert.match(code, /private readonly liveAnimated\w+ = new Set<number>\(\)/);
    assert.doesNotMatch(
      code,
      /update\(delta: number\): void \{[\s\S]*?const liveAnimated\w+ = new Set/,
    );
    assert.doesNotMatch(
      code,
      /for \(const \[entityIndex, controller\] of controllers\)/,
    );
  }
});

test("board uses one ray target over a continuous ground surface", () => {
  const board = source("src/systems/board.ts");
  const interaction = source("src/systems/interaction.ts");
  const state = source("src/systems/state.ts");

  assert.equal(board.match(/\.addComponent\(RayInteractable\)/g)?.length, 1);
  assert.match(board, /name = "BoardGround"/);
  assert.doesNotMatch(board, /terrain\.scene\.clone/);
  assert.match(board, /\.addComponent\(BoardSurface\)/);
  assert.doesNotMatch(board, /\.addComponent\(BoardTile/);
  assert.match(board, /worldToGrid\(localHit\.x, localHit\.z\)/);
  assert.match(
    interaction,
    /pressedBoard: \{ required: \[BoardSurface, Pressed\] \}/,
  );
  assert.match(state, /terrainByKey: new Map<string, BoardTerrain>\(\)/);
});

test("tablet exposes live headset performance diagnostics", () => {
  const markup = source("ui/rts-tablet.uikitml");
  const tablet = source("src/systems/tablet.ts");

  assert.match(markup, /id="settings-performance"/);
  assert.match(markup, /id="settings-frame-profile"/);
  const performanceIndex = markup.indexOf('id="settings-performance"');
  for (const view of ["overview", "build", "crafts", "units", "settings"]) {
    assert.ok(
      performanceIndex < markup.indexOf(`id="${view}-view"`),
      `performance diagnostics should remain outside the ${view} view`,
    );
  }
  assert.match(tablet, /RuntimePerformance/);
  assert.match(tablet, /movingEntities/);
});
