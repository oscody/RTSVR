/**
 * Load-time draw-call reduction.
 *
 * The project's GLBs are kit-bashed: authored as separate parts and exported
 * without ever being merged. `command_center.glb` alone is 233 meshes over 10
 * materials, and three.js issues ~1 draw call per mesh per material with no
 * auto-batching, so a single building cost ~233 draw calls. Measured on Quest
 * 2026-08-08, friendly units + buildings owned ~57% of the frame's visible
 * meshes (see devlog/2026-08-08-Why-One-Unit-Becomes-Many-Draw-Calls.md).
 *
 * No model in this project uses skinning (`skins = 0` in every GLB) — all
 * animation is node-transform animation. That means meshes sitting under the
 * SAME animated node move rigidly together and can be merged into one mesh
 * without breaking the animation. Meshes under different animated nodes cannot.
 *
 * So: group every mesh by (nearest animated ancestor, material) and merge each
 * group into a single mesh. Animated nodes are never removed, only merged INTO.
 *
 * This runs once per asset at boot against the SHARED cached GLTF, so every
 * later `AssetManager.getGLTF(key)` clone inherits the merged form for free.
 */
import {
  AssetManager,
  Matrix4,
  Mesh,
  PropertyBinding,
  type AnimationClip,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "@iwsdk/core";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export interface MergeStats {
  /** Renderable meshes before merging. */
  before: number;
  /** Renderable meshes after merging (≈ draw calls). */
  after: number;
}

/** Node names driven by an animation clip; these may never be removed. */
function animatedNodeNames(animations: AnimationClip[]): Set<string> {
  const names = new Set<string>();
  for (const clip of animations) {
    for (const track of clip.tracks) {
      const parsed = PropertyBinding.parseTrackName(track.name);
      if (parsed.nodeName) names.add(parsed.nodeName);
    }
  }
  return names;
}

/**
 * A mesh is only safe to merge away if removing its node changes nothing else:
 * it must be a plain Mesh (not skinned), single-material, morph-free, and
 * childless — a node with children would orphan them on removal.
 */
function isMergeable(node: Object3D): node is Mesh {
  const mesh = node as Mesh;
  if (!mesh.isMesh) return false;
  if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh) return false;
  if (Array.isArray(mesh.material)) return false;
  if (mesh.morphTargetInfluences?.length) return false;
  return true;
}

/**
 * Merge every rigidly-connected, same-material mesh group under `root`.
 * Mutates `root` in place. Safe to call twice (the second pass finds nothing).
 */
export function mergeRigidGroups(
  root: Object3D,
  animations: AnimationClip[] = [],
): MergeStats {
  const animated = animatedNodeNames(animations);
  root.updateMatrixWorld(true);

  // rigid group root -> material uuid -> meshes moving rigidly with it
  const groups = new Map<Object3D, Map<string, Mesh[]>>();
  let before = 0;

  const walk = (node: Object3D, rigidRoot: Object3D): void => {
    // A node driven by an animation track becomes its own rigid group root:
    // everything below it moves with it, and it must survive the merge.
    const isAnimated = animated.has(PropertyBinding.sanitizeNodeName(node.name));
    const nextRoot = isAnimated ? node : rigidRoot;
    if ((node as Mesh).isMesh) {
      before += 1;
      // A mesh with children can't be removed without orphaning them, and the
      // rigid root itself must never be removed — but both can still be merged
      // INTO, so they stay eligible as the group's target below.
      if (isMergeable(node)) {
        const material = (node as Mesh).material as Material;
        let byMaterial = groups.get(nextRoot);
        if (!byMaterial) {
          byMaterial = new Map();
          groups.set(nextRoot, byMaterial);
        }
        const bucket = byMaterial.get(material.uuid);
        if (bucket) bucket.push(node as Mesh);
        else byMaterial.set(material.uuid, [node as Mesh]);
      }
    }
    // Copy: merging mutates the children array we are iterating.
    for (const child of [...node.children]) walk(child, nextRoot);
  };
  walk(root, root);

  const inverse = new Matrix4();
  const relative = new Matrix4();

  for (const [rigidRoot, byMaterial] of groups) {
    // Some kit-bashed nodes carry a zero (or otherwise degenerate) scale, used
    // as a crude "hide this variant" switch. Matrix4.invert() returns an
    // all-zero matrix for those, and applying it computes 0 * Infinity = NaN
    // for every vertex. Everything under such a root is collapsed to nothing
    // anyway, so there is nothing worth merging — skip it.
    const determinant = rigidRoot.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) continue;

    for (const meshes of byMaterial.values()) {
      // Nodes that can't be removed (children, or the rigid root) can only be
      // merged into, not merged away — so filter them out of the removal set.
      const removable = meshes.filter(
        (m) => m !== rigidRoot && m.children.length === 0,
      );
      if (removable.length < 2 && meshes.length < 2) continue;

      // Prefer merging into the rigid root's own mesh so its name — which the
      // AnimationMixer binds tracks to — survives untouched.
      const target = meshes.includes(rigidRoot as Mesh)
        ? (rigidRoot as Mesh)
        : null;
      const sources = target ? removable : meshes;
      if (!target && removable.length !== meshes.length) continue;
      if (sources.length < (target ? 1 : 2)) continue;

      inverse.copy(rigidRoot.matrixWorld).invert();
      const geometries: BufferGeometry[] = [];
      if (target) geometries.push(target.geometry.clone());
      for (const mesh of sources) {
        relative.multiplyMatrices(inverse, mesh.matrixWorld);
        // Clone: glTF reuses one BufferGeometry across many nodes, so baking
        // the transform in place would corrupt every other user of it.
        geometries.push(mesh.geometry.clone().applyMatrix4(relative));
      }

      const merged = mergeGeometries(geometries, false);
      if (!merged) continue;
      // Validate before swapping anything in: a bad merge (mismatched or
      // degenerate source geometry) must leave the model exactly as it was
      // rather than replace it with NaN vertices.
      merged.computeBoundingBox();
      const bounds = merged.boundingBox;
      if (!bounds || Number.isNaN(bounds.min.x) || Number.isNaN(bounds.max.x)) {
        continue;
      }

      if (target) {
        target.geometry = merged;
      } else {
        const first = sources[0];
        const combined = new Mesh(merged, first.material as Material);
        combined.name = `${rigidRoot.name || "Merged"}_merged`;
        combined.castShadow = first.castShadow;
        combined.receiveShadow = first.receiveShadow;
        if (first.userData.drawCat) {
          combined.userData.drawCat = first.userData.drawCat;
        }
        rigidRoot.add(combined);
      }
      for (const mesh of sources) mesh.removeFromParent();
    }
  }

  let after = 0;
  root.traverse((node) => {
    if ((node as Mesh).isMesh) after += 1;
  });
  return { before, after };
}

/**
 * Merge every preloaded GLTF asset once, before any system clones one.
 * Must run before `registerSystem` calls that build scene content.
 */
export function optimizeLoadedAssets(keys: string[], verbose = false): void {
  let before = 0;
  let after = 0;
  for (const key of keys) {
    // `shared: true` returns the cached instance rather than a clone, so the
    // merge is inherited by every later clone of this key.
    const gltf = AssetManager.getGLTF(key, { shared: true });
    if (!gltf?.scene) continue;
    const stats = mergeRigidGroups(gltf.scene, gltf.animations ?? []);
    before += stats.before;
    after += stats.after;
    if (verbose) {
      console.log(
        `[MeshMerge] ${key}: ${stats.before} -> ${stats.after} meshes`,
      );
    }
  }
  if (verbose) {
    console.log(`[MeshMerge] total: ${before} -> ${after} meshes`);
  }
}
