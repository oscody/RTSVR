import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const FAMILY_GROUPS = [
  {
    prefix: "fx_",
    name: "fx_group",
    activeClip: "Move",
    representative: "fx_left_core",
    anchor: [0, 0.23, 1.21],
    applyActivePose: false,
    initialScale: [1, 1, 1],
    pulseBaseline: 0.15,
  },
  {
    prefix: "mining_",
    name: "mining_group",
    activeClip: "Mining_Loop",
    representative: "mining_left_strut_glow",
    anchor: [0, 0.205, -1.2],
    applyActivePose: true,
    initialScale: [0.001, 0.001, 0.001],
    pulseBaseline: null,
  },
];
const REQUIRED_CLIPS = [
  "Idle_Hover",
  "Move",
  "Mining_Loop",
  "Spawn_Construction",
];

function fail(message) {
  throw new Error(`[craft-miner-optimize] ${message}`);
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

function findNodeIndex(json, name) {
  const index = json.nodes.findIndex((node) => node.name === name);
  if (index < 0) fail(`missing node ${name}`);
  return index;
}

function findChannel(json, animation, nodeName, path) {
  return animation.channels.find((channel) => {
    return json.nodes[channel.target.node]?.name === nodeName &&
      channel.target.path === path;
  });
}

function firstSample(json, binary, animation, channel) {
  const sampler = animation.samplers[channel.sampler];
  if ((sampler.interpolation ?? "LINEAR") === "CUBICSPLINE") {
    fail(`${animation.name} uses unsupported CUBICSPLINE data`);
  }
  return readAccessor(json, binary, sampler.output)[0];
}

function applyActiveFamilyPose(state, family) {
  const animation = state.json.animations.find(
    (candidate) => candidate.name === family.activeClip,
  );
  if (!animation) fail(`missing active clip ${family.activeClip}`);
  for (const channel of animation.channels) {
    const node = state.json.nodes[channel.target.node];
    if (!node?.name?.startsWith(family.prefix)) continue;
    if (!["translation", "rotation", "scale"].includes(channel.target.path)) {
      continue;
    }
    node[channel.target.path] = firstSample(
      state.json,
      state.binary,
      animation,
      channel,
    );
  }
}

function createGroupScaleTrack(state, animation, family, groupIndex) {
  const sourceChannel = findChannel(
    state.json,
    animation,
    family.representative,
    "scale",
  );
  if (!sourceChannel) {
    fail(`${animation.name} has no ${family.representative}.scale track`);
  }
  const sourceSampler = animation.samplers[sourceChannel.sampler];
  const interpolation = sourceSampler.interpolation ?? "LINEAR";
  if (interpolation === "CUBICSPLINE") {
    fail(`${animation.name} uses unsupported CUBICSPLINE data`);
  }
  const keyCount = state.json.accessors[sourceSampler.input].count;
  let scales;
  if (animation.name === family.activeClip) {
    const source = readAccessor(state.json, state.binary, sourceSampler.output);
    const baseline = family.pulseBaseline ?? source[0][0];
    if (!Number.isFinite(baseline) || Math.abs(baseline) < 1e-6) {
      fail(`${animation.name} has an invalid family scale baseline`);
    }
    scales = source.map((value) => {
      const pulse = Math.max(0.85, Math.min(1.15, value[0] / baseline));
      return [pulse, pulse, pulse];
    });
  } else {
    scales = Array.from({ length: keyCount }, () => [0.001, 0.001, 0.001]);
  }
  if (scales.length !== keyCount) {
    fail(`${animation.name} family scale key count does not match its timeline`);
  }
  const output = appendVec3Accessor(state, scales);
  const sampler = animation.samplers.push({
    input: sourceSampler.input,
    output,
    interpolation,
  }) - 1;
  animation.channels.push({
    sampler,
    target: { node: groupIndex, path: "scale" },
  });
}

function compactAnimationSamplers(animation) {
  const used = new Map();
  const samplers = [];
  for (const channel of animation.channels) {
    let next = used.get(channel.sampler);
    if (next === undefined) {
      next = samplers.length;
      used.set(channel.sampler, next);
      samplers.push(animation.samplers[channel.sampler]);
    }
    channel.sampler = next;
  }
  animation.samplers = samplers;
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
  if (json.skins?.length) fail("source unexpectedly contains skinning");
  for (const clip of REQUIRED_CLIPS) {
    if (!json.animations.some((animation) => animation.name === clip)) {
      fail(`source is missing ${clip}`);
    }
  }

  const hullIndex = findNodeIndex(json, "craft_miner");
  const rootIndex = findNodeIndex(json, "tmpParent");
  const spawnRootIndex = findNodeIndex(json, "Spawn_Construction_FX");
  if (spawnRootIndex !== 42) {
    fail(`expected spawn subtree at node 42, found ${spawnRootIndex}`);
  }

  for (const family of FAMILY_GROUPS) {
    if (family.applyActivePose) applyActiveFamilyPose(state, family);
  }

  // The source's spawn subtree occupies nodes 42..96. Removing it leaves the
  // stable hull/effect indices 0..41, which are used by the retained tracks.
  json.nodes = json.nodes.slice(0, spawnRootIndex);
  json.nodes[rootIndex].children = (json.nodes[rootIndex].children ?? []).filter(
    (child) => child !== spawnRootIndex,
  );

  const groupIndices = new Map();
  for (const family of FAMILY_GROUPS) {
    const children = [];
    json.nodes.forEach((node, index) => {
      if (node.name?.startsWith(family.prefix)) children.push(index);
    });
    if (children.length === 0) fail(`no nodes found for ${family.prefix}`);
    for (const child of children) {
      const translation = json.nodes[child].translation ?? [0, 0, 0];
      json.nodes[child].translation = translation.map(
        (value, axis) => value - family.anchor[axis],
      );
    }
    const groupIndex = json.nodes.push({
      name: family.name,
      translation: family.anchor,
      rotation: [0, 0, 0, 1],
      scale: family.initialScale,
      children,
    }) - 1;
    groupIndices.set(family.name, groupIndex);
  }
  json.nodes[hullIndex].children = [...groupIndices.values()];

  const familyNode = (index) => {
    const name = json.nodes[index]?.name ?? "";
    return FAMILY_GROUPS.some(
      (family) => name.startsWith(family.prefix) && name !== family.name,
    );
  };
  for (const animation of json.animations) {
    const originalChannelCount = animation.channels.length;
    for (const family of FAMILY_GROUPS) {
      createGroupScaleTrack(
        state,
        animation,
        family,
        groupIndices.get(family.name),
      );
    }
    animation.channels = animation.channels.filter((channel, index) => {
      if (index >= originalChannelCount) return true;
      return channel.target.node < spawnRootIndex && !familyNode(channel.target.node);
    });
    compactAnimationSamplers(animation);
  }

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
      removedFamily: "Spawn_Construction_FX",
      animatedGroups: FAMILY_GROUPS.map((family) => family.name),
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(
    `[craft-miner-optimize] ${basename(inputPath)} -> ${basename(outputPath)}: ` +
      `${reachablePrimitiveCount(json)} reachable primitives, ` +
      `${json.nodes.length} nodes, ${json.animations.length} clips`,
  );
}

const inputPath = resolve(process.argv[2] ?? "public/gltf/craft/craft_miner_construction.glb");
const outputPath = resolve(process.argv[3] ?? "public/gltf/craft/craft_miner_A.glb");
optimize(inputPath, outputPath);
