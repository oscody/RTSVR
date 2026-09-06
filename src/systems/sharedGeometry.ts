import { BoxGeometry, Color, type Object3D } from "@iwsdk/core";
import { trackResource } from "./resourceLifetime.js";
import { MARS_GROUND_COLOR } from "./constants.js";

/**
 * Mark decoration as never hit-testable.
 *
 * Pointer raycasting runs for both hands every frame against every visible mesh
 * under a `RayInteractable`, and `Input` was measured on Quest 2026-08-09 as a
 * *sustained* ~3.5-4.5 ms — the only cost paid on every single frame. Most of
 * what is on screen is scenery nobody can click: health bars, range rings,
 * bolts, meteors, progress fills, board dressing.
 *
 * The examples treat this as a per-mesh decision made at creation
 * (`vr_examples/brushspace` opts out in 10 of its 11 mesh-creating systems);
 * RTSVR historically left everything hit-testable. Call this on anything
 * decorative. Rendering is unaffected — raycast is not draw.
 */
export function makeNonInteractive<T extends Object3D>(object: T): T {
  object.raycast = () => {};
  return object;
}

/** Resolved once: every ground decal blends over the same surface. */
const groundColor = new Color(MARS_GROUND_COLOR);

/**
 * The colour a translucent overlay resolves to once blended over the board's
 * ground — which is the only thing these decals ever blend over, since each one
 * is a flat quad, ring or line sitting just above `MARS_GROUND_COLOR`.
 *
 * ## Why a flat decal should not be translucent at all
 *
 * The Quest's `OCULUS_multiview` path loses Three.js's **transparent render
 * pass** for a frame at a time — the overlay blink investigated on 2026-09-05.
 * Three.js sorts a mesh into that pass on `material.transparent` alone, so a
 * decal whose only use of alpha is a constant opacity over a constant
 * background is paying the blink for a blend it does not need. Pre-compute the
 * blend, render opaque, and it becomes immune: the opaque pass is never
 * affected (health bars and the starfield never flicker, and both are opaque
 * while still setting `depthWrite: false`).
 *
 * ## Why not a hand-written hex
 *
 * Two reasons. The meaning disappears — nobody reading `0x894b36` later will
 * know it was "the grid at 50% over Mars ground", and they will not be able to
 * retune either input. And the obvious arithmetic is wrong: the GPU blends in
 * **linear** space, so the sRGB midpoint is a different, muddier colour
 * (`0x824633` against the correct `0x894b36` for the grid). `Color.lerpColors`
 * works in the renderer's working space, so this is the mix the blend would
 * actually have produced.
 *
 * **Only for decals that lie flat on the ground.** Anything that can be seen
 * against the sky, against a building, or against another decal still needs a
 * real blend — the pre-computed colour is only correct over the ground.
 */
export function flattenOverGround(color: number, opacity: number): Color {
  return new Color().lerpColors(groundColor, new Color(color), opacity);
}

/**
 * One unit cube reused by every interaction proxy. Proxies differ only in
 * footprint and height, so they scale this instead of allocating a fresh
 * BoxGeometry per unit — one geometry for the whole game rather than one per
 * alien, craft, and building.
 */
export const UNIT_BOX_GEOMETRY = new BoxGeometry(1, 1, 1);
// The single cube behind every interaction proxy in the game. Exactly 1 for
// the whole session — a count above that means something stopped sharing it,
// which is a draw-call regression as much as a memory one.
trackResource(UNIT_BOX_GEOMETRY, {
  kind: "geometry",
  scope: "session",
  label: "unit-box-proxy",
});
