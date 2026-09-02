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
  /**
   * A sustained bed rather than an event.
   *
   * Loops are started and stopped explicitly ({@link startAmbience}), never
   * through `playSfx`, and use `PlaybackMode.Ignore` so a second start is a
   * no-op instead of restarting the bed mid-breath — the same choice
   * `underAttackAudio.ts` makes for the alarm.
   */
  readonly loop?: boolean;
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
  /** Racer's paired cannons. Fatter than the turret so a mixed volley reads as two weapons. */
  plasma: {
    url: "/audio/sfx-plasma.wav",
    volume: 0.45,
    voices: 3,
    cooldownMs: 70,
  },
  /** Astronaut rifle. Thin and short, so it cuts through a volley without adding weight. */
  laser: {
    url: "/audio/sfx-laser.wav",
    volume: 0.4,
    voices: 3,
    cooldownMs: 70,
  },
  /**
   * Alien strike. The loudest single source in a wave — every alien in contact
   * fires it — so it carries the shortest leash: two voices and the longest
   * combat cooldown. Thirty simultaneous thuds is noise, not information.
   */
  melee: {
    url: "/audio/sfx-melee.wav",
    volume: 0.4,
    voices: 2,
    cooldownMs: 110,
  },
  /**
   * Losing something of ours. Louder than the alien death and given its own
   * voice budget: it must not be masked by the fight that caused it.
   */
  friendlyDeath: {
    url: "/audio/sfx-friendly-death.wav",
    volume: 0.7,
    voices: 2,
    cooldownMs: 150,
  },

  // ── Economy and build ───────────────────────────────────────────────────
  //
  // These are naturally spaced, so the work here is **mixing**, not limiting:
  // a crystal chime firing on a loop all match must never mask a combat cue.
  // Volumes sit deliberately below the weapons for that reason.

  /** A miner has filled up. Fires on a loop all match, so it is the quietest cue here. */
  crystal: {
    url: "/audio/sfx-crystal.wav",
    volume: 0.22,
    voices: 2,
    cooldownMs: 250,
  },
  /** Crystals arriving at the base. Rising where the pickup falls — the pair reads as a round trip. */
  deposit: {
    url: "/audio/sfx-deposit.wav",
    volume: 0.3,
    voices: 2,
    cooldownMs: 250,
  },
  /** A site staked out. A decision, not an impact. */
  place: {
    url: "/audio/sfx-place.wav",
    volume: 0.4,
    voices: 1,
    cooldownMs: 200,
  },
  /**
   * The rarest good thing that happens, and the only clearly musical cue in the
   * bank. Loud enough to carry over a fight, because it usually lands in one.
   */
  buildDone: {
    url: "/audio/sfx-build-done.wav",
    volume: 0.52,
    voices: 1,
    cooldownMs: 200,
  },
  /** A craft rolling out. Shares the build-done language without repeating it. */
  craftReady: {
    url: "/audio/sfx-craft-ready.wav",
    volume: 0.42,
    voices: 1,
    cooldownMs: 200,
  },
  /** Destructive but voluntary — heavy and final rather than violent. */
  demolish: {
    url: "/audio/sfx-demolish.wav",
    volume: 0.45,
    voices: 1,
    cooldownMs: 200,
  },

  // ── Wave and match ──────────────────────────────────────────────────────
  //
  // The loudest cues in the bank: they mark the only moments that change what
  // the player should be doing. All three are one-shot and transition-gated.
  //
  // **These volumes are set from measured loudness, not by eye.** Every clip is
  // peak-normalized to 0.89, so `volume` alone says nothing about how loud one
  // sounds against another — what matters is `volume x rms`, and the bank's rms
  // spans 0.11 to 0.51. The siren is a dense sawtooth at rms 0.506, roughly
  // 3x a weapon's, so its low-looking 0.34 lands *above* victory's 0.90.
  // `tests/sfx.test.ts` asserts the resulting hierarchy rather than the raw
  // numbers, because the raw numbers are not comparable.

  /**
   * Wave incoming. One-shot, not a loop: the wave arriving is the event, and a
   * sustained siren would still be wailing through the fight it announced.
   */
  waveSiren: {
    url: "/audio/sfx-wave-siren.wav",
    volume: 0.34,
    voices: 1,
    cooldownMs: 1000,
  },
  /** Cleared the last wave. The only fully consonant sound in the bank. */
  victory: {
    url: "/audio/sfx-victory.wav",
    volume: 0.9,
    voices: 1,
    cooldownMs: 1000,
  },
  /** Command centre lost. Slow decay, so it outlasts the moment rather than punctuating it. */
  defeat: {
    url: "/audio/sfx-defeat.wav",
    volume: 0.9,
    voices: 1,
    cooldownMs: 1000,
  },

} as const satisfies Record<string, SfxSpec>;

/** The ids that are sustained beds rather than events. */
/**
 * The ids that are sustained beds rather than events.
 *
 * **Empty — ambience is disabled, 2026-09-01.** The two generated beds
 * (`amb-base-hum`, `amb-wind`) were cut: procedural synthesis produces a
 * passable tone but not convincing wind, and neither was ever confirmed audible
 * on a headset. Backlog item 21 tracks sourcing real audio.
 *
 * **Everything around this still works.** `startAmbience` / `stopAmbience` stay
 * wired and `SfxSystem` still derives them from match status, so re-enabling is
 * this array plus a catalog entry plus a manifest entry — no new machinery. The
 * generator recipes and the WAV files are kept on disk for the same reason, and
 * `tests/sfx.test.ts` still asserts their loop seams, which is the part that was
 * genuinely hard to get right.
 */
export const AMBIENCE_IDS: readonly SfxId[] = [];

/**
 * One clip's spec, widened to {@link SfxSpec}.
 *
 * `as const satisfies` narrows every entry to its own literal type, which is
 * what makes `SfxId` exact — but it also means an entry that omits the optional
 * `loop` has no `loop` property at all, and reading it is a type error. This
 * widens once so callers see the interface rather than seventeen literal types.
 */
export const sfxSpec = (id: SfxId): SfxSpec => SFX_CATALOG[id];

/** Every URL the bank needs preloaded, for the manifest cross-check. */
export const SFX_URLS: readonly string[] = Object.values(SFX_CATALOG).map(
  (spec) => spec.url,
);
