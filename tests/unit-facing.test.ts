import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (p: string): string =>
  readFileSync(new URL(`../src/systems/${p}`, import.meta.url), "utf8");
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("a working unit faces what it is working on", () => {
  // Facing was only ever set while MOVING (`movement.ts:52`), from the
  // direction of travel. A unit that arrived and started work kept whatever
  // heading its last step left it with — an astronaut could raise a turret with
  // its back to it, and a miner could gather facing away from the crystal.
  assert.match(
    code("construction.ts"),
    /faceEntity\(astronaut, site\)/,
    "the astronaut must face its construction site",
  );
  const mining = code("mining.ts");
  assert.match(mining, /if \(stage === "gathering"\) faceEntity\(miner, node\)/);
  assert.match(
    mining,
    /else if \(stage === "deposit"\) faceEntity\(miner, boardState\.commandCenter\)/,
    "a depositing miner must face the base it is filling",
  );
});

test("only the STATIONARY stages are turned", () => {
  // The travelling stages are movement's job. Overriding them would fight the
  // turn a unit makes as it walks, which reads as a stutter.
  const mining = code("mining.ts");
  for (const travelling of ["toResource", "toBase"]) {
    assert.doesNotMatch(
      mining,
      new RegExp(`stage === "${travelling}"[^\\n]*faceEntity`),
      `${travelling} is a travelling stage — movement already points the miner`,
    );
  }
  // And the astronaut is turned only once it is actually building.
  const builders = /private advanceBuilders\(\): void \{[\s\S]*?\n  \}/.exec(code("construction.ts"))?.[0] ?? "";
  assert.ok(builders, "advanceBuilders not found");
  const guard = builders.indexOf('if (current !== "building") continue;');
  const face = builders.indexOf("faceEntity(astronaut, site)");
  assert.ok(guard >= 0 && face > guard, "the astronaut must only turn once building has started");
});

test("the helper matches the friendly yaw convention, not the enemy one", () => {
  const facing = code("unitFacing.ts");
  // `atan2(dx, dz)` — x first, matching movement.ts:52 and combat.ts:259.
  assert.match(facing, /Math\.atan2\(dx, dz\)/);
  // Aliens add a per-model forward offset because their GLBs face another axis
  // (`waveRules.enemyFacingYaw`). Friendly models do not, so this must not.
  assert.doesNotMatch(facing, /FORWARD_YAW|enemyFacingYaw/);
});

test("facing a point you are standing on is a no-op, not a snap north", () => {
  // atan2(0, 0) is 0, which would spin the unit to face north for a frame.
  const facing = code("unitFacing.ts");
  assert.match(facing, /if \(dx \* dx \+ dz \* dz < FACING_EPSILON_SQUARED\) return;/);
  // Squared comparison: this runs per working unit per frame, and a sqrt here
  // buys nothing (CLAUDE.md — no needless work in update()).
  assert.doesNotMatch(facing, /Math\.sqrt/);
});

test("a missing object3D is survivable", () => {
  // Both callers can hold an entity mid-teardown — a site being disposed, a
  // resource node that just emptied. Facing must never be the thing that throws.
  const facing = code("unitFacing.ts");
  assert.match(facing, /const holder = unit\.object3D;\s*if \(!holder\) return;/);
  assert.match(facing, /const holder = target\?\.object3D;\s*if \(!holder\) return;/);
});
