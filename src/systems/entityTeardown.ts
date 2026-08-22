import {
  type Entity,
  type Material,
  type Mesh,
  type Object3D,
  RayInteractable,
} from "@iwsdk/core";

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
export function markOwnedResources<T extends Object3D>(object: T): T {
  object.userData.ownsResources = true;
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
