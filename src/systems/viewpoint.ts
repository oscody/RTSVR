import type { World } from "@iwsdk/core";
import {
  DESKTOP_CAMERA,
  DESKTOP_CAMERA_TARGET,
  PLAYER_SPAWN,
} from "./constants.ts";

/**
 * Owns where the player stands and where the 2D preview camera sits.
 *
 * **Both live here because they are coupled.** `world.camera` is a CHILD of
 * `world.player`, so `camera.position` is rig-local: move the rig to z = 2.55
 * and a camera authored at z = 2.90 lands at world z = 5.45. Authoring the two
 * in separate files guarantees they drift, and the drift is invisible until
 * someone enters XR and finds the viewpoint somewhere else entirely.
 *
 * **Why not `render.camera` in `World.create`?** That block is applied *during*
 * world creation, before the rig has moved — so it would be overwritten by, or
 * fight with, the rig placement below. There is exactly one owner now, and this
 * is it. The `render.camera` entry was deleted from `index.ts` in the same
 * change.
 *
 * A function rather than a system: this runs once, at startup, and a system
 * would only be a way to run it one frame later. Mirrors `combatEffects.ts`'s
 * `attach*` helpers.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-20-Camera-Spawn-And-Tutorial-Phase-5-Plan.md`.
 */
export function placeViewpoint(world: World): void {
  world.player.position.set(...PLAYER_SPAWN);
  // The rig's own matrix must be current before the camera can be aimed through
  // it: `lookAt` resolves the parent's world rotation, and a stale parent matrix
  // aims the camera from where the rig USED to be. At startup that is the
  // origin, which is exactly the pose being moved away from — so the failure
  // would look like the change had not been applied at all.
  world.player.updateMatrixWorld(true);

  // Authored in WORLD space and converted, because "3.5 m above the board" is a
  // statement about the board, not about the rig. PLAYER_SPAWN has no rotation,
  // so a subtraction is the whole conversion; if the rig ever gains a yaw this
  // must become a proper worldToLocal.
  world.camera.position.set(
    DESKTOP_CAMERA[0] - PLAYER_SPAWN[0],
    DESKTOP_CAMERA[1] - PLAYER_SPAWN[1],
    DESKTOP_CAMERA[2] - PLAYER_SPAWN[2],
  );
  // `lookAt` takes a WORLD target and accounts for parenting itself.
  world.camera.lookAt(...DESKTOP_CAMERA_TARGET);
}
