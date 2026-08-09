import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const REQUIRED_SOURCE_CLIPS = [
  "Idle_Hover",
  "Move",
  "Spawn_Construction",
  "StrafeFire",
];
const ENGINE_GROUPS = [
  {
    name: "Move_Left_Group",
    suffix: "_L",
    representative: "Move_EngineGlow_L",
    anchor: [-0.325, 0.25, 0.918],
    baseline: 0.125,
  },
  {
    name: "Move_Right_Group",
    suffix: "_R",
    representative: "Move_EngineGlow_R",
    anchor: [0.325, 0.25, 0.918],
    baseline: 0.125,
  },
];
const MUZZLE_NAMES = [
  "StrafeFire_MuzzleFlash_L",
  "StrafeFire_MuzzleFlash_R",
];

function fail(message) {
  throw new Error(`[craft-racer-optimize] ${message}`);
}

function align4(value) {
  return (value + 3) & ~3;
}

function readGlb(path) {
  const file = readFileSync(path);
  if (file.readUInt32LE(0) !== GLB_MAGIC) fail(`${path} is not a GLB`);
  if (file.readUInt32LE(4) !== 2) fail(`${path} is not glTF 2.0`);

  let offset = 12;
  let json;
  let binary;
  while (offset < file.length) {
    const length = file.readUInt32LE(offset);
    const type = file.readUInt32LE(offset + 4);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      json = JSON.parse(data.toString("utf8").replace(/[\0 ]+$/u, ""));
    } else if (type === BIN_CHUNK) {
      binary = Buffer.from(data);
    }
    offset += 8 + length;
  }
  if (!json || !binary) fail(`${path} must contain JSON and BIN chunks`);
  const byteLength = json.buffers?.[0]?.byteLength;
  if (typeof byteLength !== "number") fail(`${path} has no embedded buffer`);
  return { json, binary: binary.subarray(0, byteLength) };
}

function writeGlb(path, json, binary) {
  json.buffers[0].byteLength = binary.length;
  const jsonData = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.alloc(align4(jsonData.length), 0x20);
  jsonData.copy(paddedJson);
  const paddedBinary = Buffer.alloc(align4(binary.length));
  binary.copy(paddedBinary);

  const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + paddedBinary.length);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  paddedJson.copy(output, 20);
  const binHeader = 20 + paddedJson.length;
  output.writeUInt32LE(paddedBinary.length, binHeader);
  output.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  paddedBinary.copy(output, binHeader + 8);
  writeFileSync(path, output);
}

function componentCount(type) {
  const count = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
  if (!count) fail(`unsupported accessor type ${type}`);
  return count;
}

function readAccessor(json, binary, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.componentType !== FLOAT) {
    fail(`accessor ${accessorIndex} is not FLOAT`);
  }
  const view = json.bufferViews[accessor.bufferView];
  const width = componentCount(accessor.type);
  const stride = view.byteStride ?? width * 4;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = [];
  for (let row = 0; row < accessor.count; row += 1) {
    const value = [];
    for (let column = 0; column < width; column += 1) {
      value.push(binary.readFloatLE(start + row * stride + column * 4));
    }
    values.push(value);
  }
  return values;
}

function appendVec3Accessor(state, values) {
  const start = align4(state.binary.length);
  if (start !== state.binary.length) {
    state.binary = Buffer.concat([
      state.binary,
      Buffer.alloc(start - state.binary.length),
    ]);
  }
  const data = Buffer.alloc(values.length * 12);
  values.forEach((value, row) => {
    value.forEach((component, column) => {
      data.writeFloatLE(component, row * 12 + column * 4);
    });
  });
  state.binary = Buffer.concat([state.binary, data]);
  const bufferView = state.json.bufferViews.push({
    buffer: 0,
    byteOffset: start,
    byteLength: data.length,
  }) - 1;
  return state.json.accessors.push({
    bufferView,
    componentType: FLOAT,
    count: values.length,
    type: "VEC3",
  }) - 1;
}

function findNodeIndex(nodes, name) {
  const index = nodes.findIndex((node) => node.name === name);
  if (index < 0) fail(`missing node ${name}`);
  return index;
}

function findChannel(nodes, animation, nodeName, path) {
  return animation.channels.find((channel) => {
    return nodes[channel.target.node]?.name === nodeName &&
      channel.target.path === path;
  });
}

function reachablePrimitiveCount(json) {
  const visited = new Set();
  let count = 0;
  const visit = (index) => {
    if (visited.has(index)) return;
    visited.add(index);
    const node = json.nodes[index];
    if (node.mesh !== undefined) count += json.meshes[node.mesh].primitives.length;
    for (const child of node.children ?? []) visit(child);
  };
  for (const scene of json.scenes) {
    for (const root of scene.nodes ?? []) visit(root);
  }
  return count;
}

function optimize(inputPath, outputPath) {
  const state = readGlb(inputPath);
  const { json } = state;
  const sourceNodes = json.nodes;
  const sourceAnimations = json.animations;
  if (json.skins?.length) fail("source unexpectedly contains skinning");
  for (const clip of REQUIRED_SOURCE_CLIPS) {
    if (!sourceAnimations.some((animation) => animation.name === clip)) {
      fail(`source is missing ${clip}`);
    }
  }

  const root = findNodeIndex(sourceNodes, "tmpParent");
  const hull = findNodeIndex(sourceNodes, "craft_racer");
  const exhaust = findNodeIndex(sourceNodes, "Move_Exhaust_FX");
  const fireRoot = findNodeIndex(sourceNodes, "StrafeFire_FX");
  const engineChildren = sourceNodes[exhaust].children ?? [];
  const muzzleIndices = MUZZLE_NAMES.map((name) => findNodeIndex(sourceNodes, name));
  const retained = [root, hull, exhaust, ...engineChildren, fireRoot, ...muzzleIndices];
  const oldToNew = new Map(retained.map((oldIndex, newIndex) => [oldIndex, newIndex]));

  json.nodes = retained.map((oldIndex) => {
    const node = structuredClone(sourceNodes[oldIndex]);
    node.children = (node.children ?? [])
      .filter((child) => oldToNew.has(child))
      .map((child) => oldToNew.get(child));
    if (node.children.length === 0) delete node.children;
    if (MUZZLE_NAMES.includes(node.name)) delete node.mesh;
    return node;
  });
  json.scenes = json.scenes.map((scene) => ({
    ...scene,
    nodes: (scene.nodes ?? []).filter((node) => oldToNew.has(node)).map(
      (node) => oldToNew.get(node),
    ),
  }));

  const exhaustIndex = oldToNew.get(exhaust);
  const groupIndices = new Map();
  for (const group of ENGINE_GROUPS) {
    const children = engineChildren
      .filter((oldIndex) => sourceNodes[oldIndex].name?.endsWith(group.suffix))
      .map((oldIndex) => oldToNew.get(oldIndex));
    if (children.length !== 3) {
      fail(`${group.name} expected 3 engine meshes, found ${children.length}`);
    }
    for (const child of children) {
      const translation = json.nodes[child].translation ?? [0, 0, 0];
      json.nodes[child].translation = translation.map(
        (value, axis) => value - group.anchor[axis],
      );
    }
    const groupIndex = json.nodes.push({
      name: group.name,
      translation: group.anchor,
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      children,
    }) - 1;
    groupIndices.set(group.name, groupIndex);
  }
  json.nodes[exhaustIndex].children = [...groupIndices.values()];

  json.animations = sourceAnimations
    .filter((animation) => animation.name === "Idle_Hover" || animation.name === "Move")
    .map((sourceAnimation) => {
      const animation = {
        ...sourceAnimation,
        channels: [],
        samplers: [],
      };
      const samplerMap = new Map();
      const keepSampler = (oldSampler) => {
        let next = samplerMap.get(oldSampler);
        if (next === undefined) {
          next = animation.samplers.length;
          samplerMap.set(oldSampler, next);
          animation.samplers.push(sourceAnimation.samplers[oldSampler]);
        }
        return next;
      };
      for (const channel of sourceAnimation.channels) {
        if (channel.target.node !== hull && channel.target.node !== exhaust) continue;
        animation.channels.push({
          ...channel,
          sampler: keepSampler(channel.sampler),
          target: {
            ...channel.target,
            node: oldToNew.get(channel.target.node),
          },
        });
      }

      const rootScale = findChannel(
        sourceNodes,
        sourceAnimation,
        "Move_Exhaust_FX",
        "scale",
      );
      if (!rootScale) fail(`${sourceAnimation.name} is missing exhaust visibility`);
      for (const group of ENGINE_GROUPS) {
        let sourceSampler;
        let scales;
        if (sourceAnimation.name === "Move") {
          const sourceChannel = findChannel(
            sourceNodes,
            sourceAnimation,
            group.representative,
            "scale",
          );
          if (!sourceChannel) {
            fail(`${sourceAnimation.name} is missing ${group.representative}.scale`);
          }
          sourceSampler = sourceAnimation.samplers[sourceChannel.sampler];
          const source = readAccessor(json, state.binary, sourceSampler.output);
          scales = source.map((value) => {
            const pulse = Math.max(0.85, Math.min(1.15, value[0] / group.baseline));
            return [pulse, pulse, pulse];
          });
        } else {
          sourceSampler = sourceAnimation.samplers[rootScale.sampler];
          const keyCount = json.accessors[sourceSampler.input].count;
          scales = Array.from({ length: keyCount }, () => [1, 1, 1]);
        }
        if ((sourceSampler.interpolation ?? "LINEAR") === "CUBICSPLINE") {
          fail(`${sourceAnimation.name} uses unsupported CUBICSPLINE data`);
        }
        const output = appendVec3Accessor(state, scales);
        const sampler = animation.samplers.push({
          input: sourceSampler.input,
          output,
          interpolation: sourceSampler.interpolation ?? "LINEAR",
        }) - 1;
        animation.channels.push({
          sampler,
          target: { node: groupIndices.get(group.name), path: "scale" },
        });
      }
      return animation;
    });

  for (const animation of json.animations) {
    for (const channel of animation.channels) {
      if (!json.nodes[channel.target.node]) {
        fail(`${animation.name} targets missing node ${channel.target.node}`);
      }
    }
  }
  json.asset.extras = {
    ...(json.asset.extras ?? {}),
    rtsvrOptimization: {
      source: basename(inputPath),
      removedFamilies: ["Spawn_Construction_FX", "StrafeFire geometry"],
      retainedMuzzleNodes: MUZZLE_NAMES,
      animatedGroups: ENGINE_GROUPS.map((group) => group.name),
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(
    `[craft-racer-optimize] ${basename(inputPath)} -> ${basename(outputPath)}: ` +
      `${reachablePrimitiveCount(json)} reachable primitives, ` +
      `${json.nodes.length} nodes, ${json.animations.length} clips`,
  );
}

const inputPath = resolve(
  process.argv[2] ?? "public/gltf/craft/craft_racer_construction.glb",
);
const outputPath = resolve(
  process.argv[3] ?? "public/gltf/craft/craft_racerA.glb",
);
optimize(inputPath, outputPath);
