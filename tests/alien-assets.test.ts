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
  nodes: Array<{ name?: string; mesh?: number; children?: number[] }>;
  meshes: Array<{ primitives: GlbPrimitive[] }>;
  materials: Array<{
    name?: string;
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
    };
    emissiveTexture?: { index: number };
  }>;
  scenes: Array<{ nodes?: number[] }>;
  animations: Array<{
    name: string;
    channels: Array<{ target: { node: number; path: string } }>;
  }>;
  skins?: unknown[];
  images?: Array<{ mimeType?: string; bufferView?: number }>;
  textures?: unknown[];
  samplers?: unknown[];
}

interface AssetSpec {
  source: string;
  output: string;
  kind: string;
  clips: string[];
  primitives: number;
  before: number;
  after: number;
  sharedMaterials: string[];
  sharedAttribute: "COLOR_0" | "TEXCOORD_0";
}

const ASSETS: AssetSpec[] = [
  {
    source: "../../RTSVR_repos/animation/original_uncompressed/alien_drake.glb",
    output: "../public/gltf/alien_drake.glb",
    kind: "alien-drake-materials",
    clips: ["Fly", "Attack"],
    primitives: 70,
    before: 23,
    after: 10,
    sharedMaterials: ["DrakeOpaqueVertexColors"],
    sharedAttribute: "COLOR_0",
  },
  {
    source: "../../RTSVR_repos/animation/original_uncompressed/alien_strong.glb",
    output: "../public/gltf/alien_strong.glb",
    kind: "alien-strong-material-atlas",
    clips: ["Walk", "Attack"],
    primitives: 70,
    before: 40,
    after: 11,
    sharedMaterials: ["StrongAlienMaterialAtlas"],
    sharedAttribute: "TEXCOORD_0",
  },
  {
    source: "../../RTSVR_repos/animation/original_uncompressed/alien_walking_slam_no_fx.glb",
    output: "../public/gltf/alien_walking_slam_no_fx.glb",
    kind: "alien-walker-materials",
    clips: ["Walk", "Energy_Slam"],
    primitives: 18,
    before: 18,
    after: 6,
    sharedMaterials: ["AlienWalkerVertexColors"],
    sharedAttribute: "COLOR_0",
  },
];

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

function geometryContract(primitive: GlbPrimitive): object {
  const {
    COLOR_0: _color,
    TEXCOORD_0: _texcoord,
    ...attributes
  } = primitive.attributes;
  return {
    attributes,
    indices: primitive.indices,
    mode: primitive.mode ?? 4,
  };
}

/**
 * Whether the uncompressed original for `spec` is on this machine.
 *
 * The sources live in the SIBLING repository (`../../RTSVR_repos/animation/`),
 * which no clone of this one has — CI checks out this repository alone, so the
 * comparison halves below cannot run there. They are skipped rather than
 * deleted: on a machine that has both trees they are the only thing proving the
 * optimizer did not silently drop geometry.
 *
 * Everything that reads only the committed output still runs everywhere. That
 * split is the point — a blanket skip would have taken real CI coverage with it.
 */
function sourceMissing(spec: AssetSpec): string | false {
  return existsSync(new URL(spec.source, import.meta.url))
    ? false
    : `uncompressed source not on this machine (${spec.source})`;
}

for (const spec of ASSETS) {
  test(`${spec.kind} output matches its recorded optimization contract`, () => {
    const output = readGlbJson(spec.output);

    assert.deepEqual(output.skins ?? [], []);
    assert.equal(reachablePrimitiveCount(output), spec.primitives);
    assert.equal(estimatedRuntimeMeshCount(output), spec.after);
    assert.deepEqual(
      output.animations.map(({ name }) => name),
      spec.clips,
    );
    for (const animation of output.animations) {
      assert.equal(
        animation.channels.every((channel) => output.nodes[channel.target.node]),
        true,
      );
    }
    assert.equal(output.asset.extras?.rtsvrOptimization?.kind, spec.kind);
    assert.equal(
      output.asset.extras?.rtsvrOptimization?.runtimeMeshesBefore,
      spec.before,
    );
    assert.equal(
      output.asset.extras?.rtsvrOptimization?.runtimeMeshesAfter,
      spec.after,
    );
    for (const materialName of spec.sharedMaterials) {
      const materialIndex = output.materials.findIndex(
        (material) => material.name === materialName,
      );
      assert.notEqual(materialIndex, -1);
      const converted = output.meshes.flatMap((mesh) =>
        mesh.primitives.filter((primitive) => primitive.material === materialIndex),
      );
      assert.ok(converted.length > 0);
      assert.equal(
        converted.every(
          (primitive) => primitive.attributes[spec.sharedAttribute] !== undefined,
        ),
        true,
      );
    }
  });

  test(
    `${spec.kind} preserves the source geometry, nodes, and animations`,
    { skip: sourceMissing(spec) },
    () => {
      // The half that needs BOTH trees. Nothing here can be inferred from the
      // committed output alone: it is the only check that the optimizer moved
      // materials without moving a vertex, a node, or an animation channel.
      const source = readGlbJson(spec.source);
      const output = readGlbJson(spec.output);

      assert.deepEqual(source.skins ?? [], []);
      assert.equal(reachablePrimitiveCount(source), spec.primitives);
      assert.equal(estimatedRuntimeMeshCount(source), spec.before);
      assert.deepEqual(output.nodes, source.nodes);
      assert.deepEqual(output.animations, source.animations);
      assert.equal(output.meshes.length, source.meshes.length);
      output.meshes.forEach((mesh, meshIndex) => {
        assert.deepEqual(
          mesh.primitives.map(geometryContract),
          source.meshes[meshIndex].primitives.map(geometryContract),
        );
      });
    },
  );
}

test("the skip is conditional, not a way to switch the comparison off", () => {
  // Without this, changing `sourceMissing` to return a reason unconditionally
  // would silently disable the source comparison on the machines that CAN run
  // it — and the suite would still report all green.
  const spec = ASSETS[0];
  assert.equal(
    sourceMissing({ ...spec, source: spec.output }),
    false,
    "a source that exists on disk must not be skipped",
  );
  assert.ok(
    sourceMissing({ ...spec, source: "../does-not-exist/nothing.glb" }),
    "a missing source must yield a reason string",
  );
});

test("strong alien atlas preserves every material finish in embedded textures", () => {
  const output = readGlbJson("../public/gltf/alien_strong.glb");
  const atlas = output.materials.find(
    ({ name }) => name === "StrongAlienMaterialAtlas",
  );

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
  assert.notEqual(atlas?.pbrMetallicRoughness?.baseColorTexture, undefined);
  assert.notEqual(
    atlas?.pbrMetallicRoughness?.metallicRoughnessTexture,
    undefined,
  );
  assert.notEqual(atlas?.emissiveTexture, undefined);
});

test("alien optimizer is registered as a reproducible asset command", () => {
  const packageJson = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  assert.match(packageJson, /"asset:optimize-aliens"/);
});
