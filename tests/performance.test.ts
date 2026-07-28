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
  }
});

test("tablet exposes live headset performance diagnostics", () => {
  const markup = source("ui/rts-tablet.uikitml");
  const tablet = source("src/systems/tablet.ts");

  assert.match(markup, /id="settings-performance"/);
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
