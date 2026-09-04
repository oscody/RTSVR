import {
  type Entity,
  type Material,
  type Mesh,
  type Object3D,
  RayInteractable,
} from "@iwsdk/core";
import {
  trackResource,
  type ResourceScope,
  type TrackableResource,
} from "./resourceLifetime.js";

/**
 * Tear an entity down without destroying anything it shares.
 *
 * IWSDK's `Entity.dispose()` is not "remove this entity" — it sets
 * `_disposeResources` and the world then **traverses the whole subtree and
 * disposes every geometry, material and texture it finds**
 * (`@iwsdk/core/dist/ecs/world.js:73`). Its own doc says "use with caution when
 * resources may be shared", and in this game almost everything is shared:
 *
 * - GLTF geometry/materials/textures come from the AssetManager and are common
 *   to every clone of that asset,
 * - `UNIT_BOX_GEOMETRY` is one cube for every interaction proxy in the game,
 * - the site proxy materials and `queueBadge`'s plane + per-number materials are
 *   module-level singletons.
 *
 * Measured on Quest 2026-08-21: every alien death dropped
 * `renderer.info.memory.geometries` by 12 and `renderer.info.programs` by 2, and
 * the freed shader programs were then recompiled at the next countdown — a
 * ~21 ms `getShaderInfoLog` stall each time, once per wave, all session long.
 * That is what this function exists to stop. Three.js silently re-uploads a
 * disposed-but-still-referenced resource, so the bug never looked like a bug.
 *
 * `destroy()` still detaches the Object3D and clears `entity.object3D` — that
 * happens outside the `_disposeResources` check — so nothing leaks into the
 * scene graph. Only resources this entity genuinely owns are freed, and only
 * those tagged by {@link markOwnedResources}.
 */
export function releaseEntity(entity: Entity): void {
  // Drop the ray target first: a pointer mid-hover over a destroyed entity
  // otherwise keeps a reference to it for another frame.
  if (entity.hasComponent(RayInteractable)) {
    entity.removeComponent(RayInteractable);
  }
  const object = entity.object3D;
  if (object) disposeOwnedResources(object);
  entity.destroy();
}

/**
 * Mark a mesh whose geometry and material belong to it alone, so
 * {@link releaseEntity} frees them.
 *
 * Deliberately opt-in. An unmarked mesh is never disposed, so the worst case for
 * a missed mark is a small leak; the worst case for the inverse default — mark
 * what is shared — is corrupting a resource other objects are still drawing
 * with. One of those is recoverable at the next restart and the other is the bug
 * this module was written to fix.
 */
export interface OwnedResourceMetadata {
  scope: ResourceScope;
  /** What this mesh is, e.g. `health-bar-fill`. */
  label: string;
  /** Who owns it, e.g. `entity:133`. The fastest route from a leak to a fix. */
  owner?: string;
}

/**
 * Mark a mesh as owning its private geometry and material — and, optionally,
 * register them with the lifetime tracker.
 *
 * The two concerns are deliberately one call. This function is already the
 * single point where the codebase says "these resources are mine to dispose",
 * so it is also the only place that can say "count them". Tracking anywhere
 * else would drift from disposal, and a tracker that disagrees with the
 * disposer is worse than none.
 *
 * **Metadata is optional and the disposal behaviour is unchanged without it**,
 * so existing callers keep working while sites are converted. An untracked
 * mesh is invisible to the report rather than wrong in it.
 *
 * Textures are NOT registered here. A mesh's map may be a GLTF texture, a UIKit
 * atlas or a shared canvas — none of them owned — so guessing would classify
 * external resources as ours. They stay explicit at their construction site.
 */
export function markOwnedResources<T extends Object3D>(
  object: T,
  metadata?: OwnedResourceMetadata,
): T {
  object.userData.ownsResources = true;
  if (metadata) {
    const mesh = object as unknown as Mesh;
    trackResource(mesh.geometry as unknown as TrackableResource, {
      kind: "geometry",
      scope: metadata.scope,
      label: metadata.label,
      owner: metadata.owner,
    });
    const material = mesh.material as Material | Material[] | undefined;
    // An array material is one mesh with several slots; each is disposed
    // separately by `disposeOwnedResources`, so each is counted separately.
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const entry of materials) {
      trackResource(entry as unknown as TrackableResource, {
        kind: "material",
        scope: metadata.scope,
        label: metadata.label,
        owner: metadata.owner,
      });
    }
  }
  return object;
}

function disposeOwnedResources(root: Object3D): void {
  root.traverse((node) => {
    if (node.userData.ownsResources !== true) return;
    const mesh = node as Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as Material | Material[] | undefined;
    if (!material) return;
    if (Array.isArray(material)) for (const entry of material) entry?.dispose();
    else material.dispose();
  });
}
