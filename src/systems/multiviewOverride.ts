import { DIAGNOSTICS_ENABLED } from "./traceFlags.js";

/**
 * A/B switch for OVR multiview, for the overlay-blink investigation.
 *
 * ## Why this exists
 *
 * The transparent-pass witness (`transparentPassProbe.ts`) cleared the
 * application: across a 60,680-frame wave-6 session that missed up to 61.7% of
 * its frames, Three.js issued draw calls exactly equal to its render lists on
 * every single frame — `calls === opaque + transmissive + transparent`, no
 * deficit, ever. JavaScript submitted the complete transparent pass every time
 * the overlays blinked. Whatever loses them is below `renderer.info`, which
 * counts draws *issued*, not draws *executed*.
 *
 * Multiview is the first thing below that line, and it is not this app's
 * choice. IWSDK hardcodes it:
 *
 * ```js
 * const renderer = new WebGLRenderer({
 *     antialias: true,
 *     // @ts-ignore
 *     multiviewStereo: true,
 * ```
 *
 * (`@iwsdk/core/dist/init/world-initializer.js:200-206`. Three.js's own default
 * is `multiviewStereo = false`, `three.module.js:15607`.) It was confirmed
 * ACTIVE by measurement rather than assumed: the witness reports
 * `draws/frame 1` and an overhead of `+0`, and both mean `renderScene()` runs
 * once per frame, which happens on exactly one branch —
 * `if ( xr.enabled && xr.isMultiview )` at `three.module.js:17180`. Two views
 * walking the list would double `calls`.
 *
 * Multiview is a driver path, not a Three.js one: it rewrites every shader with
 * `layout(num_views = 2)` and renders into a texture array. Blending into a
 * multiview target is exactly the kind of place an opaque/transparent split
 * comes from — and it is the only remaining candidate that explains one, since
 * depth-based reprojection does not: the health bars that survive a blink are
 * `depthWrite: false` too.
 *
 * ## Why shadowing `getExtension` rather than patching anything
 *
 * `WebGLRenderer` bakes `multiviewStereo` in at construction and IWSDK builds
 * the renderer itself, so there is no application-level option to turn off. But
 * the flag is only half the condition:
 *
 * ```js
 * scope.isMultiview = useMultiview && extensions.has( 'OCULUS_multiview' );
 * ```
 *
 * (`three.module.js:13863`.) Making the extension look absent takes the other
 * half away, and "this device has no multiview" is a state Three.js supports
 * properly: it falls back to its own per-view loop, and every multiview-specific
 * uniform path is guarded by `program.numMultiviewViews > 0`, which then stays
 * zero. So this needs no `node_modules` patch and no SDK change — the same
 * reasoning `programChurn.ts` gives for reading `renderer.properties` instead of
 * editing Three.js.
 *
 * ## How to run the A/B
 *
 * Append `?multiview=off` to the app URL. No rebuild, no redeploy — which is the
 * point when the other arm of the test is a headset. `?multiview=on` or no
 * parameter leaves the SDK's behaviour untouched.
 *
 * **Confirm which arm actually ran** from the witness line in `[Profile]`
 * rather than from intent:
 *
 * | | `draws/frame` | `calls armed` |
 * | --- | --- | --- |
 * | multiview on (SDK default) | 1 | `+0` |
 * | multiview off (this override) | 2 | roughly the list length |
 *
 * If it still reads `draws/frame 1` after asking for `off`, the override did not
 * take and the run proves nothing.
 *
 * Then: blink stops, it is a multiview interaction. Blink persists, multiview is
 * exonerated and the compositor is what is left.
 */
/**
 * The only name hidden, and deliberately the only one.
 *
 * `WebGLExtensions.has()` forwards the exact string to `gl.getExtension()` with
 * no aliasing (`three.module.js:3949-3975`), and `OCULUS_multiview` is the sole
 * multiview name Three.js ever asks for — the WebGL2 standard's
 * `OVR_multiview2` is never queried, and `GL_OVR_multiview` appears only as an
 * `#extension` directive inside generated shader source, which is not a
 * `getExtension` call. Hiding anything else would be cargo cult.
 *
 * The two places that use it both stay safe once it is absent:
 * `scope.isMultiview` goes false (`:13863`), and `multiviewExt` in
 * `WebGLTextures` is only ever dereferenced behind
 * `renderTarget.isWebGLMultiviewRenderTarget === true` (`:12096`) — a target
 * that is only created when multiview is on in the first place.
 */
const EXTENSION = "OCULUS_multiview";

let applied = false;

/** Whether the URL asked for the non-multiview arm. */
function requested(): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URLSearchParams(location.search).get("multiview") === "off";
  } catch {
    return false;
  }
}

/**
 * Call once, BEFORE `World.create()` — the renderer is built inside it and
 * queries the extension there and again at session start, so anything later is
 * too late.
 *
 * Does nothing at all unless diagnostics are on AND the URL asks for it. This
 * changes how the app renders, so it is never a default and never silent: a
 * production build cannot be pushed onto a different render path by a query
 * string.
 */
export function applyMultiviewOverride(): void {
  if (!DIAGNOSTICS_ENABLED || applied || !requested()) return;
  const contexts = [
    typeof WebGL2RenderingContext !== "undefined"
      ? WebGL2RenderingContext.prototype
      : null,
    typeof WebGLRenderingContext !== "undefined"
      ? WebGLRenderingContext.prototype
      : null,
  ].filter((proto): proto is WebGLRenderingContext => proto !== null);
  if (contexts.length === 0) return;

  applied = true;
  for (const proto of contexts) {
    // `getExtension` is declared as a long list of literal-typed overloads, and
    // a pass-through forwards a plain `string`. The widened alias is only about
    // that signature — the value forwarded is the original method itself.
    const original = proto.getExtension as unknown as (
      this: WebGLRenderingContext,
      name: string,
    ) => unknown;
    // Only that one name is hidden; everything else passes straight through, so
    // the context is otherwise exactly the one the SDK would have got.
    proto.getExtension = function (this: WebGLRenderingContext, name: string) {
      if (name === EXTENSION) return null;
      return original.call(this, name);
    } as unknown as WebGLRenderingContext["getExtension"];
  }
  console.log(
    `[MultiviewOverride] ${EXTENSION} hidden by ?multiview=off — ` +
      `expect PassWitness draws/frame 2. Contexts patched: ${contexts.length}`,
  );
}
