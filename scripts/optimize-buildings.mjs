import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const OPAQUE_COMMAND_CENTER_MATERIALS = [
  "Platform",
  "DarkArmor",
  "HazardOrange",
  "ArmorGray",
  "ArmorLight",
  "EnergyBlueDark",
  "EnergyBlue",
  "DeepArmor",
  "Silver",
];

function fail(message) {
  throw new Error(`[building-optimize] ${message}`);
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

function appendData(state, data, target) {
  const start = align4(state.binary.length);
  if (start !== state.binary.length) {
    state.binary = Buffer.concat([
      state.binary,
      Buffer.alloc(start - state.binary.length),
    ]);
  }
  state.binary = Buffer.concat([state.binary, data]);
  const bufferView = {
    buffer: 0,
    byteOffset: start,
    byteLength: data.length,
  };
  if (target !== undefined) bufferView.target = target;
  return state.json.bufferViews.push(bufferView) - 1;
}

function appendColorAccessor(state, count, color, cache) {
  const key = `${count}:${color.join(",")}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const rgba = color.map((value) => toByte(value));
  const data = Buffer.alloc(count * 4);
  for (let vertex = 0; vertex < count; vertex += 1) {
    for (let component = 0; component < 4; component += 1) {
      data[vertex * 4 + component] = rgba[component];
    }
  }
  const bufferView = appendData(state, data, ARRAY_BUFFER);
  const accessor = state.json.accessors.push({
    bufferView,
    componentType: UNSIGNED_BYTE,
    normalized: true,
    count,
    type: "VEC4",
  }) - 1;
  cache.set(key, accessor);
  return accessor;
}

function appendUvAccessor(state, count, slot, slotCount, cache) {
  const key = `${count}:${slot}:${slotCount}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const u = Math.round(((slot + 0.5) / slotCount) * 65535);
  const v = Math.round(0.5 * 65535);
  const data = Buffer.alloc(count * 4);
  for (let vertex = 0; vertex < count; vertex += 1) {
    data.writeUInt16LE(u, vertex * 4);
    data.writeUInt16LE(v, vertex * 4 + 2);
  }
  const bufferView = appendData(state, data, ARRAY_BUFFER);
  const accessor = state.json.accessors.push({
    bufferView,
    componentType: UNSIGNED_SHORT,
    normalized: true,
    count,
    type: "VEC2",
  }) - 1;
  cache.set(key, accessor);
  return accessor;
}

function toByte(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`invalid normalized component ${value}`);
  }
  return Math.round(value * 255);
}

function linearToSrgb(value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeData = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeData.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeData, data])), 8 + data.length);
  return output;
}

function createRgbaPng(pixels) {
  const width = pixels.length;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const scanline = Buffer.from([0, ...pixels.flat()]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function appendTexture(state, name, pixels, sampler) {
  const png = createRgbaPng(pixels);
  const bufferView = appendData(state, png);
  state.json.images ??= [];
  state.json.textures ??= [];
  const image = state.json.images.push({
    name,
    mimeType: "image/png",
    bufferView,
  }) - 1;
  return state.json.textures.push({ name, sampler, source: image }) - 1;
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

function estimatedRuntimeMeshCount(json) {
  const animated = new Set(
    json.animations.flatMap((animation) =>
      animation.channels.map((channel) => channel.target.node),
    ),
  );
  const groups = new Map();
  const visit = (index, rigidRoot) => {
    const nextRoot = animated.has(index) ? index : rigidRoot;
    const node = json.nodes[index];
    if (node.mesh !== undefined) {
      const materials = groups.get(nextRoot) ?? new Set();
      for (const primitive of json.meshes[node.mesh].primitives) {
        materials.add(primitive.material);
      }
      groups.set(nextRoot, materials);
    }
    for (const child of node.children ?? []) visit(child, nextRoot);
  };
  for (const scene of json.scenes) {
    for (const root of scene.nodes ?? []) visit(root, root);
  }
  return [...groups.values()].reduce((sum, materials) => sum + materials.size, 0);
}

function materialIndexByName(json, name) {
  const index = json.materials.findIndex((material) => material.name === name);
  if (index < 0) fail(`missing material ${name}`);
  return index;
}

function validateAsset(json, clips, primitives, before, label) {
  if (json.skins?.length) fail(`${label} contains skinning`);
  if (reachablePrimitiveCount(json) !== primitives) {
    fail(`${label} primitive count changed`);
  }
  if (estimatedRuntimeMeshCount(json) !== before) {
    fail(`${label} runtime baseline changed`);
  }
  if (JSON.stringify(json.animations.map(({ name }) => name)) !== JSON.stringify(clips)) {
    fail(`${label} animation clips changed`);
  }
}

function optimizeTurret() {
  const inputPath = resolve("public/gltf/equipment/turret_single_source.glb");
  const outputPath = resolve("public/gltf/equipment/turret_single.glb");
  const state = readGlb(inputPath);
  const { json } = state;
  validateAsset(json, ["Fire_Recoil"], 10, 8, basename(inputPath));

  const fire = json.animations.find(({ name }) => name === "Fire_Recoil");
  const barrelIndices = [...new Set(fire.channels.map((channel) => channel.target.node))];
  if (
    barrelIndices.length !== 2 ||
    !barrelIndices.every((index) => json.nodes[index].name === "Group")
  ) {
    fail("turret duplicate barrel-node contract changed");
  }
  for (const index of barrelIndices) {
    const x = json.nodes[index].translation?.[0];
    if (typeof x !== "number" || x === 0) fail("turret barrel has no X offset");
    json.nodes[index].name = x < 0 ? "Barrel_L" : "Barrel_R";
  }

  const sourceMaterials = new Set(json.materials.map((_, index) => index));
  for (const material of json.materials) {
    const pbr = material.pbrMetallicRoughness;
    if (
      !pbr ||
      pbr.baseColorTexture ||
      pbr.metallicRoughnessTexture ||
      pbr.metallicFactor !== 1 ||
      pbr.roughnessFactor !== 1 ||
      material.emissiveFactor
    ) {
      fail(`${material.name} is not a compatible turret material`);
    }
  }
  const sharedMaterial = json.materials.push({
    name: "TurretVertexColors",
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 1,
      roughnessFactor: 1,
    },
    alphaMode: "OPAQUE",
    doubleSided: false,
  }) - 1;
  const colorCache = new Map();
  let converted = 0;
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      if (!sourceMaterials.has(primitive.material)) continue;
      if (primitive.attributes.COLOR_0 !== undefined) {
        fail(`${mesh.name} already has vertex colors`);
      }
      const material = json.materials[primitive.material];
      const position = json.accessors[primitive.attributes.POSITION];
      primitive.attributes.COLOR_0 = appendColorAccessor(
        state,
        position.count,
        material.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1],
        colorCache,
      );
      primitive.material = sharedMaterial;
      converted += 1;
    }
  }
  if (converted !== 10) fail(`turret converted ${converted}, expected 10`);
  const after = estimatedRuntimeMeshCount(json);
  if (after !== 3) fail(`turret estimates ${after} runtime meshes, expected 3`);
  json.asset.extras = {
    ...(json.asset.extras ?? {}),
    rtsvrOptimization: {
      kind: "turret-materials",
      source: basename(inputPath),
      runtimeMeshesBefore: 8,
      runtimeMeshesAfter: after,
      sharedMaterial: "TurretVertexColors",
      barrelNodes: ["Barrel_L", "Barrel_R"],
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(`[building-optimize] turret_single.glb: 10 -> ${after} runtime meshes`);
}

function optimizeCommandCenter() {
  const inputPath = resolve("public/gltf/command_center_source.glb");
  const outputPath = resolve("public/gltf/command_center.glb");
  const state = readGlb(inputPath);
  const { json } = state;
  validateAsset(
    json,
    ["Idle_Operational", "Door_Open", "Door_Close"],
    233,
    34,
    basename(inputPath),
  );

  const materialIndices = OPAQUE_COMMAND_CENTER_MATERIALS.map((name) =>
    materialIndexByName(json, name),
  );
  const slotByMaterial = new Map(
    materialIndices.map((material, slot) => [material, slot]),
  );
  const materials = materialIndices.map((index) => json.materials[index]);
  for (const material of materials) {
    const pbr = material.pbrMetallicRoughness;
    if (
      !pbr ||
      pbr.baseColorTexture ||
      pbr.metallicRoughnessTexture ||
      material.alphaMode && material.alphaMode !== "OPAQUE" ||
      material.doubleSided
    ) {
      fail(`${material.name} is not a compatible opaque command-center material`);
    }
  }

  json.samplers ??= [];
  const sampler = json.samplers.push({
    name: "CommandCenterAtlasNearest",
    magFilter: 9728,
    minFilter: 9728,
    wrapS: 33071,
    wrapT: 33071,
  }) - 1;
  const baseColorTexture = appendTexture(
    state,
    "CommandCenterBaseColorAtlas",
    materials.map((material) => {
      const factor = material.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1];
      return [
        toByte(linearToSrgb(factor[0])),
        toByte(linearToSrgb(factor[1])),
        toByte(linearToSrgb(factor[2])),
        toByte(factor[3]),
      ];
    }),
    sampler,
  );
  const metallicRoughnessTexture = appendTexture(
    state,
    "CommandCenterMetallicRoughnessAtlas",
    materials.map((material) => {
      const pbr = material.pbrMetallicRoughness;
      return [
        255,
        toByte(pbr.roughnessFactor ?? 1),
        toByte(pbr.metallicFactor ?? 1),
        255,
      ];
    }),
    sampler,
  );
  const emissiveTexture = appendTexture(
    state,
    "CommandCenterEmissiveAtlas",
    materials.map((material) => {
      const factor = material.emissiveFactor ?? [0, 0, 0];
      return [
        toByte(linearToSrgb(factor[0])),
        toByte(linearToSrgb(factor[1])),
        toByte(linearToSrgb(factor[2])),
        255,
      ];
    }),
    sampler,
  );
  const sharedMaterial = json.materials.push({
    name: "CommandCenterOpaqueAtlas",
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: baseColorTexture },
      metallicFactor: 1,
      roughnessFactor: 1,
      metallicRoughnessTexture: { index: metallicRoughnessTexture },
    },
    emissiveFactor: [1, 1, 1],
    emissiveTexture: { index: emissiveTexture },
    alphaMode: "OPAQUE",
    doubleSided: false,
  }) - 1;
  const uvCache = new Map();
  let converted = 0;
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const slot = slotByMaterial.get(primitive.material);
      if (slot === undefined) continue;
      if (primitive.attributes.TEXCOORD_0 !== undefined) {
        fail(`${mesh.name} already has texture coordinates`);
      }
      const position = json.accessors[primitive.attributes.POSITION];
      primitive.attributes.TEXCOORD_0 = appendUvAccessor(
        state,
        position.count,
        slot,
        materials.length,
        uvCache,
      );
      primitive.material = sharedMaterial;
      converted += 1;
    }
  }
  if (converted !== 207) {
    fail(`command center converted ${converted}, expected 207`);
  }
  const after = estimatedRuntimeMeshCount(json);
  if (after !== 15) {
    fail(`command center estimates ${after} runtime meshes, expected 15`);
  }
  json.asset.extras = {
    ...(json.asset.extras ?? {}),
    rtsvrOptimization: {
      kind: "command-center-material-atlas",
      source: basename(inputPath),
      runtimeMeshesBefore: 34,
      runtimeMeshesAfter: after,
      atlasMaterial: "CommandCenterOpaqueAtlas",
      atlasSlots: OPAQUE_COMMAND_CENTER_MATERIALS,
      preservedMaterial: "EnergyGlass",
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(`[building-optimize] command_center.glb: 233 -> ${after} runtime meshes`);
}

optimizeTurret();
optimizeCommandCenter();
