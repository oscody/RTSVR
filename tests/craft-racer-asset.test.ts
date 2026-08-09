import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface GlbNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
}

interface GlbAnimation {
  name?: string;
  channels: Array<{ target: { node: number; path: string } }>;
}

interface GlbJson {
  nodes: GlbNode[];
  meshes: Array<{ primitives: unknown[] }>;
  scenes: Array<{ nodes?: number[] }>;
  animations: GlbAnimation[];
  skins?: unknown[];
}

function readGlbJson(path: string): GlbJson {
  const file = readFileSync(new URL(path, import.meta.url));
  const jsonLength = file.readUInt32LE(12);
  return JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
}

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function reachablePrimitiveCount(gltf: GlbJson): number {
  const visited = new Set<number>();
  let count = 0;
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const node = gltf.nodes[index];
    if (node.mesh !== undefined) {
      count += gltf.meshes[node.mesh].primitives.length;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const scene of gltf.scenes) {
    for (const root of scene.nodes ?? []) visit(root);
  }
  return count;
}

test("completed racer keeps movement and empty cannon muzzle anchors", () => {
  const gltf = readGlbJson("../public/gltf/craft/craft_racerA.glb");
  const byName = new Map(gltf.nodes.map((node) => [node.name, node]));

  assert.deepEqual(gltf.skins ?? [], []);
  assert.equal(reachablePrimitiveCount(gltf), 10);
  assert.deepEqual(
    gltf.animations.map((animation) => animation.name),
    ["Idle_Hover", "Move"],
  );
  assert.equal(byName.has("Spawn_Construction_FX"), false);
  assert.equal(byName.has("Move_Left_Group"), true);
  assert.equal(byName.has("Move_Right_Group"), true);
  assert.deepEqual(byName.get("StrafeFire_MuzzleFlash_L")?.translation, [
    -0.58, 0.2, -0.98,
  ]);
  assert.deepEqual(byName.get("StrafeFire_MuzzleFlash_R")?.translation, [
    0.58, 0.2, -0.98,
  ]);
  assert.equal(byName.get("StrafeFire_MuzzleFlash_L")?.mesh, undefined);
  assert.equal(byName.get("StrafeFire_MuzzleFlash_R")?.mesh, undefined);
  assert.equal(
    gltf.nodes.some(
      (node) => node.name?.startsWith("StrafeFire_") &&
        !["StrafeFire_FX", ...[
          "StrafeFire_MuzzleFlash_L",
          "StrafeFire_MuzzleFlash_R",
        ]].includes(node.name),
    ),
    false,
  );

  for (const animation of gltf.animations) {
    const targets = animation.channels.map(
      (channel) => gltf.nodes[channel.target.node]?.name,
    );
    assert.equal(targets.includes(undefined), false);
    assert.equal(targets.includes("Move_Left_Group"), true);
    assert.equal(targets.includes("Move_Right_Group"), true);
    assert.equal(
      targets.some(
        (name) => name?.startsWith("Move_") &&
          !["Move_Exhaust_FX", "Move_Left_Group", "Move_Right_Group"].includes(name),
      ),
      false,
    );
  }
});

test("construction-only racer retains the full spawn and fire source", () => {
  const gltf = readGlbJson("../public/gltf/craft/craft_racer_construction.glb");
  const nodeNames = new Set(gltf.nodes.map((node) => node.name));

  assert.equal(reachablePrimitiveCount(gltf), 70);
  assert.equal(nodeNames.has("Spawn_Construction_FX"), true);
  assert.equal(nodeNames.has("spawn_pixel_14"), true);
  assert.equal(nodeNames.has("StrafeFire_Bolt_3_R"), true);
  assert.deepEqual(
    gltf.animations.map((animation) => animation.name),
    ["Idle_Hover", "Move", "Spawn_Construction", "StrafeFire"],
  );
});

test("racer construction uses the full source asset only while building", () => {
  const index = readSource("../src/index.ts");
  const production = readSource("../src/systems/craftProduction.ts");

  assert.match(
    index,
    /craftRacerConstruction: \{ url: "\/gltf\/craft\/craft_racer_construction\.glb"/,
  );
  assert.match(
    production,
    /spec\.asset === "craftRacer"[\s\S]*\? "craftRacerConstruction"/,
  );
});
