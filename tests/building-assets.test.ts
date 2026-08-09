import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

interface GlbPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material: number;
  mode?: number;
}

interface GlbJson {
  asset: {
    extras?: {
      rtsvrOptimization?: {
        kind?: string;
        runtimeMeshesBefore?: number;
        runtimeMeshesAfter?: number;
      };
    };
  };
  nodes: Array<{
    name?: string;
    mesh?: number;
    children?: number[];
    [key: string]: unknown;
  }>;
  meshes: Array<{ primitives: GlbPrimitive[] }>;
  materials: Array<{
    name?: string;
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
    };
    emissiveTexture?: { index: number };
    [key: string]: unknown;
  }>;
  scenes: Array<{ nodes?: number[] }>;
  animations: Array<{
    name: string;
    channels: Array<{ target: { node: number; path: string } }>;
  }>;
  images?: Array<{ mimeType?: string; bufferView?: number }>;
  textures?: unknown[];
  samplers?: unknown[];
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

function estimatedRuntimeMeshCount(gltf: GlbJson): number {
  const animated = new Set(
    gltf.animations.flatMap((animation) =>
      animation.channels.map((channel) => channel.target.node),
    ),
  );
  const groups = new Map<number, Set<number>>();
  const visit = (index: number, rigidRoot: number): void => {
    const nextRoot = animated.has(index) ? index : rigidRoot;
    const node = gltf.nodes[index];
    if (node.mesh !== undefined) {
      const materials = groups.get(nextRoot) ?? new Set<number>();
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        materials.add(primitive.material);
      }
      groups.set(nextRoot, materials);
    }
    for (const child of node.children ?? []) visit(child, nextRoot);
  };
  for (const scene of gltf.scenes) {
    for (const root of scene.nodes ?? []) visit(root, root);
  }
  return [...groups.values()].reduce(
    (total, materials) => total + materials.size,
    0,
  );
}

test("turret shares one material and binds recoil to named barrels", () => {
  const output = readGlbJson("../public/gltf/equipment/turret_single.glb");
  const recoil = output.animations.find(({ name }) => name === "Fire_Recoil");
  const targets = recoil?.channels.map(
    (channel) => output.nodes[channel.target.node]?.name,
  );

  assert.deepEqual(output.skins ?? [], []);
  assert.equal(reachablePrimitiveCount(output), 10);
  assert.equal(estimatedRuntimeMeshCount(output), 3);
  assert.deepEqual(targets?.sort(), ["Barrel_L", "Barrel_R"]);
  assert.deepEqual(
    output.animations.map(({ name }) => name),
    ["Fire_Recoil"],
  );
  const shared = output.materials.findIndex(
    ({ name }) => name === "TurretVertexColors",
  );
  assert.notEqual(shared, -1);
  const primitives = output.meshes.flatMap(({ primitives }) => primitives);
  assert.equal(primitives.every(({ material }) => material === shared), true);
  assert.equal(
    primitives.every(({ attributes }) => attributes.COLOR_0 !== undefined),
    true,
  );
  assert.equal(output.asset.extras?.rtsvrOptimization?.kind, "turret-materials");
  assert.equal(output.asset.extras?.rtsvrOptimization?.runtimeMeshesBefore, 8);
  assert.equal(output.asset.extras?.rtsvrOptimization?.runtimeMeshesAfter, 3);
});

test("command center atlas preserves geometry, animation, and transparent glass", () => {
  const output = readGlbJson("../public/gltf/command_center.glb");

  assert.deepEqual(output.skins ?? [], []);
  assert.equal(reachablePrimitiveCount(output), 233);
  assert.equal(estimatedRuntimeMeshCount(output), 15);
  assert.deepEqual(
    output.animations.map(({ name }) => name),
    ["Idle_Operational", "Door_Open", "Door_Close"],
  );
  const atlas = output.materials.findIndex(
    ({ name }) => name === "CommandCenterOpaqueAtlas",
  );
  const glassMaterial = output.materials.findIndex(
    ({ name }) => name === "EnergyGlass",
  );
  assert.notEqual(atlas, -1);
  assert.notEqual(glassMaterial, -1);
  assert.equal(output.images?.length, 3);
  assert.equal(output.textures?.length, 3);
  assert.equal(output.samplers?.length, 1);
  assert.equal(
    output.images?.every(
      ({ mimeType, bufferView }) =>
        mimeType === "image/png" && bufferView !== undefined,
    ),
    true,
  );
  assert.notEqual(
    output.materials[atlas].pbrMetallicRoughness?.baseColorTexture,
    undefined,
  );
  assert.notEqual(
    output.materials[atlas].pbrMetallicRoughness?.metallicRoughnessTexture,
    undefined,
  );
  assert.notEqual(output.materials[atlas].emissiveTexture, undefined);

  const primitives = output.meshes.flatMap(({ primitives }) => primitives);
  const atlased = primitives.filter(({ material }) => material === atlas);
  const glass = primitives.filter(({ material }) => material === glassMaterial);
  assert.equal(atlased.length, 207);
  assert.equal(glass.length, 26);
  assert.equal(
    atlased.every(({ attributes }) => attributes.TEXCOORD_0 !== undefined),
    true,
  );
  assert.equal(
    output.asset.extras?.rtsvrOptimization?.kind,
    "command-center-material-atlas",
  );
  assert.equal(output.asset.extras?.rtsvrOptimization?.runtimeMeshesBefore, 34);
  assert.equal(output.asset.extras?.rtsvrOptimization?.runtimeMeshesAfter, 15);
});

test("building optimizer uses external inputs and legacy source GLBs stay absent", () => {
  const packageJson = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const optimizer = readFileSync(
    new URL("../scripts/optimize-buildings.mjs", import.meta.url),
    "utf8",
  );
  assert.match(packageJson, /"asset:optimize-buildings"/);
  assert.doesNotMatch(optimizer, /turret_single_source\.glb/);
  assert.doesNotMatch(optimizer, /command_center_source\.glb/);
  assert.match(optimizer, /source must live outside public\//);
  assert.equal(
    existsSync(
      new URL("../public/gltf/equipment/turret_single_source.glb", import.meta.url),
    ),
    false,
  );
  assert.equal(
    existsSync(
      new URL("../public/gltf/command_center_source.glb", import.meta.url),
    ),
    false,
  );
});
