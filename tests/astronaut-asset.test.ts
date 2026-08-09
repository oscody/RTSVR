import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface GlbPrimitive {
  attributes: { POSITION: number; COLOR_0?: number };
  material: number;
}

interface GlbNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GlbAnimation {
  name: string;
  channels: Array<{ target: { node: number; path: string } }>;
}

interface GlbJson {
  asset: { extras?: { rtsvrOptimization?: { kind?: string } } };
  nodes: GlbNode[];
  meshes: Array<{ primitives: GlbPrimitive[] }>;
  materials: Array<{ name?: string }>;
  scenes: Array<{ nodes?: number[] }>;
  animations: GlbAnimation[];
  skins?: unknown[];
}

function readGlbJson(path: string): GlbJson {
  const file = readFileSync(new URL(path, import.meta.url));
  const jsonLength = file.readUInt32LE(12);
  return JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
}

function estimatedRuntimeMeshCount(gltf: GlbJson): number {
  const animated = new Set(
    gltf.animations.flatMap((animation) =>
      animation.channels.map((channel) => channel.target.node),
    ),
  );
  const parents = new Map<number, number>();
  gltf.nodes.forEach((node, parent) => {
    for (const child of node.children ?? []) parents.set(child, parent);
  });
  const groups = new Map<number, Array<{ node: number; material: number }>>();
  const visit = (index: number, rigidRoot: number): void => {
    const nextRoot = animated.has(index) ? index : rigidRoot;
    const node = gltf.nodes[index];
    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const meshes = groups.get(nextRoot) ?? [];
        meshes.push({ node: index, material: primitive.material });
        groups.set(nextRoot, meshes);
      }
    }
    for (const child of node.children ?? []) visit(child, nextRoot);
  };
  for (const scene of gltf.scenes) {
    for (const root of scene.nodes ?? []) visit(root, root);
  }

  const hasDegenerateWorldScale = (index: number): boolean => {
    let current: number | undefined = index;
    while (current !== undefined) {
      if ((gltf.nodes[current].scale ?? [1, 1, 1]).some((value) => value === 0)) {
        return true;
      }
      current = parents.get(current);
    }
    return false;
  };
  let count = 0;
  for (const [rigidRoot, meshes] of groups) {
    count += hasDegenerateWorldScale(rigidRoot)
      ? meshes.length
      : new Set(meshes.map((mesh) => mesh.material)).size;
  }
  return count;
}

test("astronaut keeps four clips while suit and weapon merge to 14 meshes", () => {
  const gltf = readGlbJson("../public/gltf/astronautA_A.glb");
  const sharedMaterial = gltf.materials.findIndex(
    (material) => material.name === "AstronautSuitVertexColors",
  );
  const weaponNames = new Set([
    "held_weapon_part_0",
    "held_weapon_part_1",
    "held_weapon_part_2",
    "held_weapon_part_3",
  ]);

  assert.deepEqual(gltf.skins ?? [], []);
  assert.equal(gltf.asset.extras?.rtsvrOptimization?.kind, "astronaut-materials");
  assert.deepEqual(
    gltf.animations.map((animation) => animation.name),
    ["Walk", "Shoot", "BeaconPlacement", "LaserPointAssist"],
  );
  assert.equal(estimatedRuntimeMeshCount(gltf), 14);

  const bakedPrimitives = gltf.nodes.flatMap((node) =>
    node.mesh === undefined
      ? []
      : gltf.meshes[node.mesh].primitives.filter(
          (primitive) => primitive.material === sharedMaterial,
        ),
  );
  assert.equal(bakedPrimitives.length, 22);
  assert.equal(
    bakedPrimitives.every((primitive) => primitive.attributes.COLOR_0 !== undefined),
    true,
  );

  const weaponRootIndex = gltf.nodes.findIndex(
    (node) => node.name === "held_weapon_part_0",
  );
  const weaponRoot = gltf.nodes[weaponRootIndex];
  assert.deepEqual(
    (weaponRoot.children ?? []).map((index) => gltf.nodes[index].name),
    ["held_weapon_part_1", "held_weapon_part_2", "held_weapon_part_3"],
  );
  for (const animation of gltf.animations) {
    const targets = animation.channels
      .map((channel) => gltf.nodes[channel.target.node]?.name)
      .filter((name) => name !== undefined && weaponNames.has(name));
    assert.equal(targets.every((name) => name === "held_weapon_part_0"), true);
    assert.equal(
      animation.channels.every((channel) => gltf.nodes[channel.target.node]),
      true,
    );
  }
});
