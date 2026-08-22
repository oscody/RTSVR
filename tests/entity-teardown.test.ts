import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const systemsUrl = new URL("../src/systems/", import.meta.url);
const read = (file: string) =>
  readFileSync(new URL(file, systemsUrl), "utf8");
const systemFiles = readdirSync(systemsUrl).filter((f) => f.endsWith(".ts"));

// IWSDK's `Entity.dispose()` is not "remove this entity". It sets
// `_disposeResources`, and the world then traverses the entire subtree and
// disposes every geometry, material and texture under it
// (@iwsdk/core/dist/ecs/world.js:73). Nearly everything in this game is shared —
// GLTF assets across clones, UNIT_BOX_GEOMETRY across every proxy, the queue
// badge's plane and per-number materials — so disposing one alien frees
// resources a dozen live objects are still drawing with.
//
// Measured on Quest 2026-08-21: each alien death dropped
// renderer.info.memory.geometries by 12 and renderer.info.programs by 2, and the
// freed programs were recompiled at the next countdown for a ~21 ms stall.
// Three.js silently re-uploads a disposed-but-referenced resource, which is why
// it never looked like a bug.
test("entity teardown never uses IWSDK's traverse-disposing dispose()", () => {
  const teardown = read("entityTeardown.ts");
  assert.match(teardown, /entity\.destroy\(\)/);
  assert.doesNotMatch(teardown, /entity\.dispose\(\)/);

  const offenders: string[] = [];
  for (const file of systemFiles) {
    const source = read(file);
    for (const [index, line] of source.split("\n").entries()) {
      // An ECS entity handle being disposed. Geometry/material/texture
      // `.dispose()` is a different call and stays allowed.
      if (/^\s*(?:[A-Za-z_$][\w$]*)\.dispose\(\);/.test(line) &&
          !/\.(geometry|material|texture|map)\b/.test(line)) {
        offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `use releaseEntity() instead of entity.dispose():\n${offenders.join("\n")}`,
  );
});

test("every entity teardown path goes through releaseEntity", () => {
  for (const file of [
    "combat.ts",
    "demolition.ts",
    "construction.ts",
    "craftProduction.ts",
    "scenarioReset.ts",
    "selection.ts",
  ]) {
    assert.match(read(file), /releaseEntity\(/, file);
  }
});

// Opt-in by design: an unmarked mesh is never disposed, so a missed mark leaks a
// little until restart, while the inverse default would corrupt a resource other
// objects are still drawing with.
test("only resources an entity owns alone are marked for disposal", () => {
  const teardown = read("entityTeardown.ts");
  assert.match(teardown, /userData\.ownsResources/);
  assert.match(teardown, /node\.userData\.ownsResources !== true\) return/);

  // Per-instance visuals: each one allocates its own geometry and material.
  for (const [file, count] of [
    ["construction.ts", 3], // foundation, progress background, progress fill
    ["craftProduction.ts", 3],
    ["healthBar.ts", 2], // background, fill
    ["selection.ts", 4], // selection + attack-range + turret + enemy rings
  ] as const) {
    const marks = read(file).match(/markOwnedResources\(/g)?.length ?? 0;
    assert.equal(marks, count, `${file} marks ${marks}, expected ${count}`);
  }
});

test("shared singletons are never marked as owned", () => {
  // The one cube behind every interaction proxy, and the one plane behind every
  // queue badge. Marking either would take it away from the whole game.
  assert.doesNotMatch(
    read("sharedGeometry.ts"),
    /markOwnedResources/,
    "UNIT_BOX_GEOMETRY is shared by every proxy",
  );
  assert.doesNotMatch(
    read("queueBadge.ts"),
    /markOwnedResources/,
    "badge plane and per-number materials are cached and shared",
  );
  // The site proxies reuse the shared cube and a module-level material, so the
  // proxy mesh must stay unmarked even though its siblings are marked.
  for (const file of ["construction.ts", "craftProduction.ts"]) {
    const source = read(file);
    assert.match(source, /new Mesh\(UNIT_BOX_GEOMETRY, \w+\)/, file);
    assert.doesNotMatch(
      source,
      /markOwnedResources\(\s*proxy\s*\)/,
      `${file} must not dispose the shared proxy cube`,
    );
  }
});
