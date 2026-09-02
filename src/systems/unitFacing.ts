import type { Entity } from "@iwsdk/core";

/**
 * Turn a unit to face a point on the board.
 *
 * ## Why this exists
 *
 * Facing was only ever set **while moving** (`movement.ts:52`), from the
 * direction of travel. A unit that arrived and started working kept whatever
 * heading its last step left it with — so an astronaut could build a wall with
 * its back to it, and a miner could gather while facing away from the crystal.
 *
 * Combat already solved the same problem inline (`combat.ts:259`), turning an
 * attacker toward its target. This is that idea extracted rather than copied a
 * third and fourth time.
 *
 * ## The yaw convention
 *
 * `Math.atan2(dx, dz)` — x first, matching `movement.ts` and `combat.ts`. Note
 * this is **not** the enemy convention: aliens add a per-model forward offset
 * (`waveRules.enemyFacingYaw`) because their GLBs face a different axis.
 * Friendly models do not need one, which is why this takes no offset.
 *
 * No-ops when the unit is already effectively on top of the target, because
 * `atan2(0, 0)` is 0 and would snap the unit to face north for one frame.
 */
export function faceWorldPoint(unit: Entity, x: number, z: number): void {
  const holder = unit.object3D;
  if (!holder) return;
  const dx = x - holder.position.x;
  const dz = z - holder.position.z;
  // Squared, to avoid a sqrt on a path that runs per working unit per frame.
  if (dx * dx + dz * dz < FACING_EPSILON_SQUARED) return;
  holder.rotation.y = Math.atan2(dx, dz);
}

/**
 * Turn a unit to face another entity.
 *
 * Reads the target's live world position rather than its grid tile, so a unit
 * faces where the thing actually is — a resource node and a command centre are
 * both wider than one tile, and their origins are not their centres.
 */
export function faceEntity(unit: Entity, target: Entity | null): void {
  const holder = target?.object3D;
  if (!holder) return;
  faceWorldPoint(unit, holder.position.x, holder.position.z);
}

/**
 * ~1cm at board scale. Below this the direction is noise, not intent.
 *
 * Squared once here rather than at each call.
 */
const FACING_EPSILON_SQUARED = 0.0001;
