import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ORIGINALS = "../RTSVR_repos/animation/original_uncompressed";

const ASSETS = [
  {
    kind: "alien-drake-materials",
    source: `${ORIGINALS}/alien_drake.glb`,
    output: "public/gltf/alien_drake.glb",
    clips: ["Fly", "Attack"],
    primitives: 70,
    before: 23,
    after: 10,
    groups: [
      {
        name: "DrakeOpaqueVertexColors",
        sources: [
          "Leaf Green",
          "Wing Membrane",
          "Amber Gold",
          "Mouth Dark",
          "Deep Green",
          "Claw Gray",
        ],
        expectedPrimitives: 58,
        material: {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            roughnessFactor: 0.82,
            metallicFactor: 0,
          },
          alphaMode: "OPAQUE",
          doubleSided: true,
        },
      },
    ],
  },
  {
    kind: "alien-strong-material-atlas",
    source: `${ORIGINALS}/alien_strong.glb`,
    output: "public/gltf/alien_strong.glb",
    clips: ["Walk", "Attack"],
    primitives: 70,
    before: 40,
    after: 11,
    atlas: {
      name: "StrongAlienMaterialAtlas",
      sources: [
        "Dark Gray Armor",
        "Mid Gray Armor",
        "Black Recess",
        "Energy Glow",
        "Light Gray Armor",
        "Mint Armor",
        "Orange Armor",
        "Orange Shadow",
        "Mint Shadow",
      ],
      expectedPrimitives: 70,
    },
  },
  {
    kind: "alien-walker-materials",
    source: `${ORIGINALS}/alien_walking_slam_no_fx.glb`,
    output: "public/gltf/alien_walking_slam_no_fx.glb",
    clips: ["Walk", "Energy_Slam"],
    primitives: 18,
    before: 18,
    after: 6,
    groups: [
      {
        name: "AlienWalkerVertexColors",
        sources: ["crystal", "metal", "metalRed", "metalDark", "dark"],
        expectedPrimitives: 18,
        material: {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 1,
            roughnessFactor: 1,
          },
          alphaMode: "OPAQUE",
          doubleSided: false,
        },
      },
    ],
  },
];

function fail(message) {
  throw new Error(`[alien-optimize] ${message}`);
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

function appendColorAccessor(state, count, color, cache) {
  const key = `${count}:${color.join(",")}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

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
    target: ARRAY_BUFFER,
  }) - 1;
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
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels.length, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, ...pixels.flat()]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function appendTexture(state, name, pixels, sampler) {
  const bufferView = appendData(state, createRgbaPng(pixels));
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
      for (const primitive of json.meshes[node.mesh].primitives) {
        const materials = groups.get(nextRoot) ?? new Set();
        materials.add(primitive.material);
        groups.set(nextRoot, materials);
      }
    }
    for (const child of node.children ?? []) visit(child, nextRoot);
  };
  for (const scene of json.scenes) {
    for (const root of scene.nodes ?? []) visit(root, root);
  }
  return [...groups.values()].reduce((sum, materials) => sum + materials.size, 0);
}

function requireMaterialIndices(json, names, label) {
  const byName = new Map(
    json.materials.map((material, index) => [material.name, index]),
  );
  return names.map((name) => {
    const index = byName.get(name);
    if (index === undefined) fail(`${label} is missing material ${name}`);
    return index;
  });
}

function consolidateAtlas(state, atlas, label) {
  const { json } = state;
  const materialIndices = requireMaterialIndices(json, atlas.sources, label);
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
      fail(`${material.name} is not a compatible opaque atlas material`);
    }
  }

  json.samplers ??= [];
  const sampler = json.samplers.push({
    name: `${atlas.name}Nearest`,
    magFilter: 9728,
    minFilter: 9728,
    wrapS: 33071,
    wrapT: 33071,
  }) - 1;
  const baseColorTexture = appendTexture(
    state,
    `${atlas.name}BaseColor`,
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
    `${atlas.name}MetallicRoughness`,
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
    `${atlas.name}Emissive`,
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
    name: atlas.name,
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
  if (converted !== atlas.expectedPrimitives) {
    fail(`${atlas.name} converted ${converted}, expected ${atlas.expectedPrimitives}`);
  }
  return {
    atlasMaterial: atlas.name,
    atlasSlots: atlas.sources,
    atlasedPrimitives: converted,
  };
}

function optimize(spec) {
  const inputPath = resolve(spec.source);
  const outputPath = resolve(spec.output);
  const state = readGlb(inputPath);
  const { json } = state;
  if (json.skins?.length) fail(`${basename(inputPath)} contains skinning`);
  if (reachablePrimitiveCount(json) !== spec.primitives) {
    fail(`${basename(inputPath)} primitive count changed`);
  }
  if (estimatedRuntimeMeshCount(json) !== spec.before) {
    fail(`${basename(inputPath)} runtime baseline changed`);
  }
  if (JSON.stringify(json.animations.map(({ name }) => name)) !== JSON.stringify(spec.clips)) {
    fail(`${basename(inputPath)} animation clips changed`);
  }

  let optimizationDetails;
  if (spec.atlas) {
    optimizationDetails = consolidateAtlas(
      state,
      spec.atlas,
      basename(inputPath),
    );
  } else {
    const sourceMaterialByName = new Map(
      json.materials.map((material, index) => [material.name, index]),
    );
    const colorCache = new Map();
    const convertedGroups = [];
    for (const group of spec.groups) {
      const sourceMaterials = new Set(group.sources.map((name) => {
        const index = sourceMaterialByName.get(name);
        if (index === undefined) fail(`${basename(inputPath)} is missing material ${name}`);
        return index;
      }));
      const sharedMaterial = json.materials.push({
        name: group.name,
        ...structuredClone(group.material),
      }) - 1;
      let converted = 0;
      for (const mesh of json.meshes) {
        for (const primitive of mesh.primitives) {
          if (!sourceMaterials.has(primitive.material)) continue;
          if (primitive.attributes.COLOR_0 !== undefined) {
            fail(`${mesh.name} already has vertex colors`);
          }
          const source = json.materials[primitive.material];
          const pbr = source.pbrMetallicRoughness;
          if (!pbr || pbr.baseColorTexture || pbr.metallicRoughnessTexture) {
            fail(`${source.name} is not a flat-color material`);
          }
          const position = json.accessors[primitive.attributes.POSITION];
          primitive.attributes.COLOR_0 = appendColorAccessor(
            state,
            position.count,
            pbr.baseColorFactor ?? [1, 1, 1, 1],
            colorCache,
          );
          primitive.material = sharedMaterial;
          converted += 1;
        }
      }
      if (converted !== group.expectedPrimitives) {
        fail(`${group.name} converted ${converted}, expected ${group.expectedPrimitives}`);
      }
      convertedGroups.push({ material: group.name, primitives: converted });
    }
    optimizationDetails = { groups: convertedGroups };
  }

  const after = estimatedRuntimeMeshCount(json);
  if (after !== spec.after) {
    fail(`${basename(outputPath)} estimates ${after} runtime meshes, expected ${spec.after}`);
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
      kind: spec.kind,
      source: basename(inputPath),
      runtimeMeshesBefore: spec.before,
      runtimeMeshesAfter: after,
      ...optimizationDetails,
    },
  };
  writeGlb(outputPath, json, state.binary);
  console.log(
    `[alien-optimize] ${basename(inputPath)} -> ${basename(outputPath)}: ` +
      `${spec.before} -> ${after} runtime meshes, ${spec.clips.length} clips`,
  );
}

for (const spec of ASSETS) optimize(spec);
