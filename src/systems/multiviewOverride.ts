import { DIAGNOSTICS_ENABLED } from "./traceFlags.js";

/**
 * Multiview off by default, with an A/B switch back on — from the overlay-blink
 * investigation.
 *
 * ## Why this exists
 *
 * A transparent-pass witness — since removed from the tree, and written up in
 * `RTSVR_repos/devlog/Video/issue/2026-09-05-Overlay-Dropout-Investigation.md`
 * — cleared the application: across a 60,680-frame wave-6 session that missed
 * up to 61.7% of its frames, Three.js issued draw calls exactly equal to its
 * render lists on every single frame — `calls === opaque + transmissive +
 * transparent`, no deficit, ever. JavaScript submitted the complete transparent
 * pass every time the overlays blinked. Whatever loses them is below
 * `renderer.info`, which counts draws *issued*, not draws *executed*.
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
 * ACTIVE by measurement rather than assumed: a since-removed witness recorded
 * one `renderScene()` per frame, which happens on exactly one branch —
 * `if ( xr.enabled && xr.isMultiview )` at `three.module.js:17180`. Two views
 * would have walked the render list twice.
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
 * ## Off by default, and how to get the SDK path back
 *
 * Multiview is **off by default**: this applies on every load, production
 * builds included, with no query string. That is a deliberate reversal of how
 * the file started. It was an opt-in arm behind `?multiview=off`, on the
 * principle that a render-path change should never be a default — but the blink
 * it was built to test for is a shipped-experience bug, and the arm that does
 * not blink is the one players should get. A default nobody has to remember
 * beats a flag someone will forget.
 *
 * `?multiview=on` restores the SDK's own path for one load. That is now the only
 * way to run the other arm of the A/B, and it is still a query string rather
 * than a rebuild for the same reason as before: the other arm of the test is a
 * headset.
 *
 * Because this is a production behaviour now, the patch itself is NOT gated on
 * `DIAGNOSTICS_ENABLED` — only the logging is. A `npm run build` app renders on
 * exactly the path a diagnostics run measures, and says nothing about it. Gating
 * the patch would mean shipping the one configuration never tested.
 *
 * **Confirm which arm actually ran** from {@link reportMultiviewState}, never
 * from intent. Every diagnostics session logs one of:
 *
 * ```
 * [MultiviewOverride] MEASURED: OCULUS_multiview AVAILABLE -> multiview ON
 * [MultiviewOverride] MEASURED: OCULUS_multiview absent -> multiview OFF
 * ```
 *
 * and an override that was asked for but did not take is called out explicitly
 * as `OVERRIDE FAILED`. A run whose arm is unconfirmed proves nothing.
 *
 * Then, comparing a default load against a `?multiview=on` one: blink only on
 * the `on` arm and it is a multiview interaction, which is what this default
 * bets on. Blink on both and multiview is exonerated, the compositor is what is
 * left — and this default should be reverted rather than left standing as a
 * change that costs a GPU optimisation and fixes nothing.
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

/**
 * Whether the URL asked to opt back into the SDK's multiview path.
 *
 * Absence means off — so a non-browser context with no `location` (the
 * strip-types test runner) also gets the default, rather than silently taking
 * the arm the app no longer ships.
 */
function sdkPathRequested(): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URLSearchParams(location.search).get("multiview") === "on";
  } catch {
    return false;
  }
}

/**
 * Call once, BEFORE `World.create()` — the renderer is built inside it and
 * queries the extension there and again at session start, so anything later is
 * too late.
 *
 * Runs on every load unless `?multiview=on` asks for the SDK path. Deliberately
 * not gated on `DIAGNOSTICS_ENABLED` — see the header: this is how the app
 * renders now, in production as much as in development.
 */
export function applyMultiviewOverride(): void {
  if (applied) return;
  if (sdkPathRequested()) {
    // Log the untouched arm too. Silence here would be indistinguishable from
    // an override that failed to apply, and every arm of this investigation
    // that was assumed rather than reported cost a run to re-do.
    // Reports what it DID, not what the resulting state is — it cannot know
    // that. The first run of this line claimed "multiview left ON" while the
    // MEASURED line below correctly said OFF, because a desktop browser has no
    // `OCULUS_multiview` at all. Asserting a state instead of measuring it is
    // the exact mistake this investigation has repeatedly paid for.
    if (DIAGNOSTICS_ENABLED)
      console.log(
        `[MultiviewOverride] not patching (?multiview=on asked for the SDK ` +
          `path). The SDK requests multiviewStereo: true; actual state on the ` +
          `MEASURED line below.`,
      );
    return;
  }
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
  if (DIAGNOSTICS_ENABLED)
    console.log(
      `[MultiviewOverride] ${EXTENSION} hidden by default — contexts patched: ` +
        `${contexts.length}. ?multiview=on restores the SDK path. Confirm with ` +
        `the MEASURED line below.`,
    );
}

/**
 * Report the arm that is actually in force, read off the live GL context.
 *
 * The boot line above states *intent*; this states *fact*. They can disagree —
 * a patch applied too late, a context created before the shadow was installed,
 * or a device with no multiview at all would each leave the boot line claiming
 * something the renderer never saw.
 *
 * This matters more than it sounds. The transparent-pass witness used to supply
 * this confirmation as a per-frame draw count (1 with multiview, 2 without), and it was
 * the only thing that proved which path a recording was made on. That witness
 * has been removed, so without this a session's arm is unverifiable and the
 * whole A/B becomes a matter of recollection again.
 *
 * Call once, AFTER `World.create()` resolves.
 */
export function reportMultiviewState(world: unknown): void {
  if (!DIAGNOSTICS_ENABLED) return;
  const renderer = (world as { renderer?: { getContext?: () => unknown } })
    ?.renderer;
  const gl = renderer?.getContext?.() as WebGLRenderingContext | undefined;
  if (!gl?.getExtension) {
    console.log("[MultiviewOverride] MEASURED: no GL context to read");
    return;
  }
  // Ask the live context the same question Three.js asks
  // (`extensions.has('OCULUS_multiview')`, three.module.js:13863). Whatever it
  // answers here is what the renderer will act on.
  const available = gl.getExtension(EXTENSION) !== null;
  console.log(
    `[MultiviewOverride] MEASURED: ${EXTENSION} ` +
      `${available ? "AVAILABLE -> multiview ON" : "absent -> multiview OFF"}` +
      `${applied && available ? " (OVERRIDE FAILED — the patch installed but the extension is still visible)" : ""}`,
  );
}
