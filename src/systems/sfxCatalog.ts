/**
 * The clip table. Every tunable number for the sound bank lives here; `sfx.ts`
 * holds none.
 *
 * Follows the existing `*Catalog.ts` convention (`buildingCatalog.ts`,
 * `craftCatalog.ts`, `waveCatalog.ts`): pure data, no imports from the ECS, so
 * it stays unit-testable without a world.
 *
 * ## The URL rule
 *
 * `url` must be **byte-identical to the `AssetManifest` entry in `index.ts`**.
 * It is the URL, never the manifest key. A key does not resolve, gets fetched
 * as a path, and the dev server answers with `index.html` — which decodes as
 * `EncodingError: Unable to decode audio data`, every frame. Measured
 * 2026-08-09; recorded at `constants.ts:382`. A test asserts the two lists
 * match, because the failure is silent on desktop and total on device.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Game-Audio-Plan.md`.
 */

export interface SfxSpec {
  /** Byte-identical to the manifest URL. Never the manifest key. */
  readonly url: string;
  /** 0..1, before the global scale in `sfx.ts`. */
  readonly volume: number;
  /**
   * Simultaneous voices from this one source. `PlaybackMode.Overlap` gives N
   * concurrent instances from a single `AudioSource` and steals the oldest past
   * that (`@iwsdk/core/dist/audio/audio-system.js`, `playOverlap`) — which is
   * how every `vr_examples` case does rapid fire, target-practice's SMG at
   * `maxInstances: 6` included. 1 means "retrigger, never overlap".
   */
  readonly voices: number;
  /**
   * Minimum gap between retriggers, ms. Later calls inside the window are
   * dropped, never queued.
   *
   * This is a **readability** control, not a safety one. The engine already
   * bounds concurrent voices via `voices` + the steal policy, so nothing here
   * prevents an audio-thread problem. What it prevents is thirty melee hits in
   * a wave arriving as thirty audible thuds when what is wanted is a texture.
   */
  readonly cooldownMs: number;
}

export type SfxId = keyof typeof SFX_CATALOG;

export const SFX_CATALOG = {
  /**
   * Near-inaudible in isolation, by design — it is the texture under a tap, not
   * an event. One voice: a second click should retrigger, not layer.
   */
  click: {
    url: "/audio/sfx-click.wav",
    volume: 0.35,
    voices: 1,
    cooldownMs: 40,
  },
  /**
   * Fired up to ~4x/second per turret, and there can be several turrets. Three
   * voices is the plan's estimate for "overlap expected"; the 70 ms cooldown is
   * what stops a bank of turrets smearing into one continuous tone.
   */
  turretZap: {
    url: "/audio/sfx-turret-zap.wav",
    volume: 0.5,
    voices: 3,
    cooldownMs: 70,
  },
  /**
   * Bursty at wave end, when a dozen aliens can die within a second. Two voices
   * and a longer cooldown: deaths want to read as individual events, so a few
   * clear ones beat twelve overlapping.
   */
  alienDeath: {
    url: "/audio/sfx-alien-death.wav",
    volume: 0.55,
    voices: 2,
    cooldownMs: 120,
  },
} as const satisfies Record<string, SfxSpec>;

/** Every URL the bank needs preloaded, for the manifest cross-check. */
export const SFX_URLS: readonly string[] = Object.values(SFX_CATALOG).map(
  (spec) => spec.url,
);
