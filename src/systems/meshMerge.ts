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
  type AnimationClip,
  AssetManager,
  type BufferGeometry,
  DoubleSide,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  PropertyBinding,
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
 * Render transparent double-sided materials in one pass instead of two.
 *
 * three.js draws a `transparent && side === DoubleSide` material **twice** —
 * once back faces, once front — and forces a shader-program re-derivation before
 * each pass (`three.cjs:76518`):
 *
 * ```
 * material.side = BackSide;  material.needsUpdate = true;  renderBufferDirect(...)
 * material.side = FrontSide; material.needsUpdate = true;  renderBufferDirect(...)
 * ```
 *
 * That is two draw calls and two full `getParameters` rebuilds per object per
 * frame, forever. Measured on Quest 2026-08-22 it was the entire remaining
 * program-selection cost: every churning material was one of these — glass,
 * thruster glows, heat haze, embers, laser beams — re-deriving exactly twice per
 * object per frame, and `__version` was the field that differed.
 *
 * `forceSinglePass` (three r151+) collapses it to one pass. The two-pass form
 * exists to depth-sort a transparent object's own back faces behind its front
 * faces; for the additive and emissive glows this affects, blending is
 * order-independent and the result is identical. Anything where it is not
 * identical should set `forceSinglePass = false` again on that material by name.
 */
export function useSinglePassTransparency(root: Object3D): string[] {
  const changed: string[] = [];
  const seen = new Set<Material>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      if (material.transparent !== true) continue;
      if (material.side !== DoubleSide) continue;
      if (material.forceSinglePass === true) continue;
      material.forceSinglePass = true;
      changed.push(material.name || material.type);
    }
  });
  return changed;
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
export function optimizeLoadedAssets(
  keys: string[],
  verbose = false,
  /**
   * Optional per-key progress, for the loading overlay.
   *
   * This pass is the honest half of the load bar: it is the one stretch where
   * the app knows exactly how much work is left (31 keys, counted) and how far
   * through it is. `command_center.glb` alone collapses 233 meshes to 15, so it
   * is also slow enough to be worth showing.
   */
  onProgress?: (done: number, total: number) => void,
): void {
  let before = 0;
  let after = 0;
  const twoPass: string[] = [];
  let done = 0;
  for (const key of keys) {
    // `shared: true` returns the cached instance rather than a clone, so the
    // merge is inherited by every later clone of this key.
    const gltf = AssetManager.getGLTF(key, { shared: true });
    // Reported before the `continue`, so a missing key still advances the bar.
    // Otherwise one absent asset silently stalls the overlay short of 100%.
    done += 1;
    onProgress?.(done, keys.length);
    if (!gltf?.scene) continue;
    const stats = mergeRigidGroups(gltf.scene, gltf.animations ?? []);
    before += stats.before;
    after += stats.after;
    // Same one-time, shared-instance hook: every later clone inherits the flag.
    const singlePass = useSinglePassTransparency(gltf.scene);
    if (singlePass.length > 0) {
      twoPass.push(...singlePass);
      if (verbose) {
        console.log(`[SinglePass] ${key}: ${singlePass.join(", ")}`);
      }
    }
    if (verbose) {
      console.log(
        `[MeshMerge] ${key}: ${stats.before} -> ${stats.after} meshes`,
      );
    }
  }
  if (verbose) {
    console.log(`[MeshMerge] total: ${before} -> ${after} meshes`);
  }
  // Always report this one: it halves the draw calls for those objects and
  // removes two program re-derivations each per frame, so a change in the count
  // is a change in frame cost worth noticing in a log.
  if (twoPass.length > 0) {
    console.log(
      `[SinglePass] ${twoPass.length} transparent double-sided materials collapsed to one pass`,
    );
  }
}
