import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface GlbNode {
  name?: string;
  mesh?: number;
  children?: number[];
  scale?: number[];
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

test("completed miner asset keeps four clips with consolidated effects", () => {
  const gltf = readGlbJson("../public/gltf/craft/craft_miner_A.glb");
  const nodeNames = new Set(gltf.nodes.map((node) => node.name));

  assert.deepEqual(gltf.skins ?? [], []);
  assert.equal(nodeNames.has("Spawn_Construction_FX"), false);
  assert.equal(nodeNames.has("fx_group"), true);
  assert.equal(nodeNames.has("mining_group"), true);
  assert.deepEqual(
    gltf.nodes.find((node) => node.name === "fx_group")?.scale,
    [1, 1, 1],
  );
  assert.deepEqual(
    gltf.nodes.find((node) => node.name === "mining_group")?.scale,
    [0.001, 0.001, 0.001],
  );
  assert.equal(reachablePrimitiveCount(gltf), 44);
  assert.deepEqual(
    gltf.animations.map((animation) => animation.name),
    ["Idle_Hover", "Move", "Mining_Loop", "Spawn_Construction"],
  );

  for (const animation of gltf.animations) {
    const targets = animation.channels.map(
      (channel) => gltf.nodes[channel.target.node]?.name,
    );
    assert.equal(targets.includes(undefined), false);
    assert.equal(targets.includes("fx_group"), true);
    assert.equal(targets.includes("mining_group"), true);
    assert.equal(
      targets.some((name) => name?.startsWith("fx_") && name !== "fx_group"),
      false,
    );
    assert.equal(
      targets.some(
        (name) => name?.startsWith("mining_") && name !== "mining_group",
      ),
      false,
    );
  }
});

// Retained as SOURCE only — see the matching note in craft-racer-asset.test.ts.
test("unshipped miner construction source retains the complete spawn effect", () => {
  const gltf = readGlbJson("../public/gltf/craft/craft_miner_construction.glb");
  const nodeNames = new Set(gltf.nodes.map((node) => node.name));

  assert.equal(nodeNames.has("Spawn_Construction_FX"), true);
  assert.equal(nodeNames.has("spawn_particle_root"), true);
  assert.equal(nodeNames.has("spawn_pixel_14"), true);
  assert.equal(reachablePrimitiveCount(gltf), 94);
  assert.equal(
    gltf.animations.some((animation) => animation.name === "Spawn_Construction"),
    true,
  );
});
