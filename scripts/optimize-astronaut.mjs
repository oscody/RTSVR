import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const UNSIGNED_BYTE = 5121;
const REQUIRED_CLIPS = [
  "Walk",
  "Shoot",
  "BeaconPlacement",
  "LaserPointAssist",
];
const SUIT_ROOT_NAMES = new Set([
  "astronautA",
  "armLeft",
  "armRight",
]);
const WEAPON_NAMES = [
  "held_weapon_part_0",
  "held_weapon_part_1",
  "held_weapon_part_2",
  "held_weapon_part_3",
];

function fail(message) {
  throw new Error(`[astronaut-optimize] ${message}`);
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

  const output = Buffer.alloc(
    12 + 8 + paddedJson.length + 8 + paddedBinary.length,
  );
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

function findNodeIndex(json, name) {
  const index = json.nodes.findIndex((node) => node.name === name);
  if (index < 0) fail(`missing node ${name}`);
  return index;
}

function appendColorAccessor(state, count, color) {
  const start = align4(state.binary.length);
  if (start !== state.binary.length) {
    state.binary = Buffer.concat([
      state.binary,
      Buffer.alloc(start - state.binary.length),
    ]);
  }
  const rgba = color.map((value) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      fail(`invalid base color component ${value}`);
    }
    return Math.round(value * 255);
  });
  const data = Buffer.alloc(count * 4);
  for (let vertex = 0; vertex < count; vertex += 1) {
    for (let component = 0; component < 4; component += 1) {
      data[vertex * 4 + component] = rgba[component];
    }
  }
  state.binary = Buffer.concat([state.binary, data]);
  const bufferView = state.json.bufferViews.push({
    buffer: 0,
    byteOffset: start,
    byteLength: data.length,
  }) - 1;
  return state.json.accessors.push({
    bufferView,
    componentType: UNSIGNED_BYTE,
    normalized: true,
    count,
    type: "VEC4",
  }) - 1;
}

function descendants(json, rootIndex) {
  const result = new Set();
  const visit = (index) => {
    if (result.has(index)) return;
    result.add(index);
    for (const child of json.nodes[index].children ?? []) visit(child);
  };
  visit(rootIndex);
  return result;
}

function sameTransform(left, right) {
  const transform = (node) => ({
    translation: node.translation ?? [0, 0, 0],
    rotation: node.rotation ?? [0, 0, 0, 1],
    scale: node.scale ?? [1, 1, 1],
  });
  return JSON.stringify(transform(left)) === JSON.stringify(transform(right));
}

function accessorBytes(state, accessorIndex) {
  const accessor = state.json.accessors[accessorIndex];
  if (accessor.sparse) fail(`sparse accessor ${accessorIndex} is unsupported`);
  const view = state.json.bufferViews[accessor.bufferView];
  const componentCount = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
  }[accessor.type];
  const componentSize = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  }[accessor.componentType];
  if (!componentCount || !componentSize) {
    fail(`unsupported accessor ${accessorIndex}`);
  }
  const elementSize = componentCount * componentSize;
  const stride = view.byteStride ?? elementSize;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (stride === elementSize) {
    return state.binary.subarray(start, start + accessor.count * elementSize);
  }
  const result = Buffer.alloc(accessor.count * elementSize);
  for (let row = 0; row < accessor.count; row += 1) {
    state.binary.copy(
      result,
      row * elementSize,
      start + row * stride,
      start + row * stride + elementSize,
    );
  }
  return result;
}

function sameAccessorData(state, leftIndex, rightIndex) {
  const left = state.json.accessors[leftIndex];
  const right = state.json.accessors[rightIndex];
  return (
    left.componentType === right.componentType &&
    left.count === right.count &&
    left.type === right.type &&
    Boolean(left.normalized) === Boolean(right.normalized) &&
    accessorBytes(state, leftIndex).equals(accessorBytes(state, rightIndex))
  );
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

function consolidateSuitMaterials(state) {
  const { json } = state;
  const suitNodes = new Set();
  for (const name of SUIT_ROOT_NAMES) {
    for (const index of descendants(json, findNodeIndex(json, name))) {
      suitNodes.add(index);
    }
  }
  for (const name of WEAPON_NAMES) suitNodes.add(findNodeIndex(json, name));

  const sharedMaterial = json.materials.push({
    name: "AstronautSuitVertexColors",
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 1,
      roughnessFactor: 1,
    },
    alphaMode: "OPAQUE",
    doubleSided: false,
  }) - 1;
  const accessorCache = new Map();
  let converted = 0;

  for (const index of suitNodes) {
    const node = json.nodes[index];
    if (node.mesh === undefined) continue;
    for (const primitive of json.meshes[node.mesh].primitives) {
      if (primitive.attributes.COLOR_0 !== undefined) {
        fail(`${node.name} already has vertex colors`);
      }
      const material = json.materials[primitive.material];
      const pbr = material?.pbrMetallicRoughness;
      if (
        !pbr ||
        pbr.baseColorTexture ||
        pbr.metallicRoughnessTexture ||
        pbr.metallicFactor !== 1 ||
        pbr.roughnessFactor !== 1
      ) {
        fail(`${node.name} does not use a compatible flat suit material`);
      }
      const color = pbr.baseColorFactor ?? [1, 1, 1, 1];
      const position = json.accessors[primitive.attributes.POSITION];
      const key = `${position.count}:${color.join(",")}`;
      let colorAccessor = accessorCache.get(key);
      if (colorAccessor === undefined) {
        colorAccessor = appendColorAccessor(state, position.count, color);
        accessorCache.set(key, colorAccessor);
      }
      primitive.attributes.COLOR_0 = colorAccessor;
      primitive.material = sharedMaterial;
      converted += 1;
    }
  }
  if (converted !== 22) {
    fail(`expected 22 suit/weapon primitives, converted ${converted}`);
  }
  return { converted, sharedMaterial };
}

function consolidateWeaponAnimation(state) {
  const { json } = state;
  const indices = WEAPON_NAMES.map((name) => findNodeIndex(json, name));
  const [rootIndex, ...childIndices] = indices;
  const root = json.nodes[rootIndex];
  for (const childIndex of childIndices) {
    if (!sameTransform(root, json.nodes[childIndex])) {
      fail(`${json.nodes[childIndex].name} transform differs from weapon root`);
    }
  }

  for (const animation of json.animations) {
    const weaponChannels = animation.channels.filter((channel) =>
      indices.includes(channel.target.node),
    );
    if (weaponChannels.length === 0) continue;
    const rootChannels = weaponChannels.filter(
      (channel) => channel.target.node === rootIndex,
    );
    if (rootChannels.length * indices.length !== weaponChannels.length) {
      fail(`${animation.name} has asymmetric weapon tracks`);
    }
    for (const rootChannel of rootChannels) {
      const rootSampler = animation.samplers[rootChannel.sampler];
      for (const childIndex of childIndices) {
        const childChannel = weaponChannels.find(
          (channel) =>
            channel.target.node === childIndex &&
            channel.target.path === rootChannel.target.path,
        );
        const childSampler = animation.samplers[childChannel?.sampler];
        if (
          !childChannel ||
          !sameAccessorData(state, childSampler.input, rootSampler.input) ||
          !sameAccessorData(state, childSampler.output, rootSampler.output) ||
          (childSampler.interpolation ?? "LINEAR") !==
            (rootSampler.interpolation ?? "LINEAR")
        ) {
          fail(`${animation.name} weapon tracks are not identical`);
        }
      }
    }
    animation.channels = animation.channels.filter(
      (channel) => !childIndices.includes(channel.target.node),
    );
    compactAnimationSamplers(animation);
  }

  for (const node of json.nodes) {
    if (!node.children) continue;
    node.children = node.children.filter((child) => !childIndices.includes(child));
  }
  root.children = [...(root.children ?? []), ...childIndices];
  for (const childIndex of childIndices) {
    const child = json.nodes[childIndex];
    child.translation = [0, 0, 0];
    child.rotation = [0, 0, 0, 1];
    child.scale = [1, 1, 1];
  }
  return { root: root.name, children: childIndices.length };
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
  if (json.asset.extras?.rtsvrOptimization?.kind === "astronaut-materials") {
    fail("source is already optimized");
  }
  for (const clip of REQUIRED_CLIPS) {
    if (!json.animations.some((animation) => animation.name === clip)) {
      fail(`source is missing ${clip}`);
    }
  }

  const materialResult = consolidateSuitMaterials(state);
  const weaponResult = consolidateWeaponAnimation(state);
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
      kind: "astronaut-materials",
      source: basename(inputPath),
      bakedPrimitives: materialResult.converted,
      sharedMaterial: "AstronautSuitVertexColors",
      weaponRoot: weaponResult.root,
      groupedWeaponParts: weaponResult.children + 1,
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(
    `[astronaut-optimize] ${basename(inputPath)} -> ${basename(outputPath)}: ` +
      `${reachablePrimitiveCount(json)} reachable primitives, ` +
      `${json.nodes.length} nodes, ${json.animations.length} clips`,
  );
}

const inputPath = resolve(process.argv[2] ?? "public/gltf/astronautA_A.glb");
const outputPath = resolve(process.argv[3] ?? inputPath);
optimize(inputPath, outputPath);
