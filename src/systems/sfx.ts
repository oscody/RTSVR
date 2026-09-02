import { AudioSource, AudioUtils, PlaybackMode, createSystem } from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";
import {
  audioContextState,
  reportAudioContextIfSuspended,
} from "./audioUnlock.js";
import { DebugSettings, MatchState, boardState } from "./state.js";
import {
  AMBIENCE_IDS,
  SFX_CATALOG,
  sfxSpec,
  type SfxId,
} from "./sfxCatalog.js";

/**
 * The shared sound bank: one emitter per clip, created once, replayed forever.
 *
 * Generalizes the pattern `underAttackAudio.ts` already proved for two sounds —
 * persistent entities built in `init()`, never touched per frame, a
 * module-level enable gate, `AudioUtils.play` rather than manual gain work.
 *
 * ## Why one emitter per clip and not a voice pool
 *
 * The plan specified per-clip pools of 2–3 entities with round-robin voice
 * assignment, modelled on `combatEffects.ts`. **The engine already does this.**
 * `PlaybackMode.Overlap` with `maxInstances: N` creates up to N concurrent
 * instances from a *single* `AudioSource` and applies a steal policy past that
 * (`@iwsdk/core/dist/audio/audio-system.js`, `playOverlap`). Every audio case
 * in `vr_examples` uses exactly that and none of them pools — target-practice's
 * SMG, the fastest of them, is one source at `maxInstances: 6`.
 *
 * A pool buys one thing the engine cannot: **per-voice positioning**. N voices
 * from one entity all play from that entity's position, so three turrets on
 * three tiles would be three sounds from one point.
 *
 * That only matters if positional audio is audible here at all, and the board is
 * a ~1 m tabletop. The plan lists this as Open Decision 1, *"resolved by test 4
 * on device, not before"* — so this ships listener-relative, which is what
 * `underAttackAudio.ts` already does and what a diorama argues for. If the
 * device test shows directionality is worth having, `SfxSpec` gains a position
 * and this module grows the pool. Building it first would have been committing
 * to an answer before the question was asked.
 *
 * ## Why a leaf module
 *
 * Called from combat, mining, construction, the tablet and the wave system.
 * Importing none of them keeps it at the bottom of the graph, the same reason
 * `actionLog.ts` and `tutorialWaveGate.ts` import nothing from their callers.
 */

/** Emitter per clip, built once in `init()`. Null before the system runs. */
const emitters = new Map<SfxId, Entity>();

/** Last play time per clip, for the cooldown. Monotonic ms. */
const lastPlayedAt = new Map<SfxId, number>();

/**
 * Master scale, 0..1, mirrored from `DebugSettings.sfxVolume` each frame.
 *
 * **0 is the off switch.** A separate enabled flag would be a second way to say
 * the same thing, and the bank costs 0.047 ms/frame measured on device, so
 * skipping the work buys nothing worth a second control.
 */
let volumeScale = 1;

/** Last scale pushed to the emitters, so the poll below only writes on change. */
let appliedScale = 1;

/** Whether the beds are running, so a repeat start does not restart them. */
let ambiencePlaying = false;

/** Long enough that the bed is never heard arriving or leaving. */
const AMBIENCE_FADE_SECONDS = 2;

/**
 * Play a one-shot.
 *
 * Safe to call from anywhere, including before the system has initialized —
 * a missing emitter is a silent no-op, never a throw. Audio must never be able
 * to take down a frame.
 */
export function playSfx(id: SfxId): void {
  const entity = emitters.get(id);
  if (!entity) return;

  const spec = sfxSpec(id);
  // A loop started through the one-shot path would never stop, and the cooldown
  // below would make the failure intermittent rather than obvious.
  if (spec.loop) return;
  const now = performance.now();
  const last = lastPlayedAt.get(id) ?? -Infinity;
  // Dropped, not queued. A queued backlog would keep firing after the fight
  // that caused it had ended.
  if (now - last < spec.cooldownMs) return;
  lastPlayedAt.set(id, now);

  // A suspended AudioContext means silence with no error anywhere, and a
  // headset has no console to notice it in. `underAttackAudio.ts` already
  // reports this for the alert pair; the bank must too, or "I heard nothing on
  // Quest" has two indistinguishable causes — a real decode failure, and the
  // browser simply never having been credited a user gesture. Warns once per
  // session, so it is safe on this path.
  reportAudioContextIfSuspended(id);
  AudioUtils.play(entity);
}

/**
 * Global volume scale, 0..1, applied on top of each clip's own volume.
 *
 * Written to every emitter immediately rather than at play time: `volume` is
 * component data, and reading it per play would be a component read on a path
 * that runs at combat rates.
 */
export function setSfxVolume(scale: number): void {
  volumeScale = Math.max(0, Math.min(1, scale));
  appliedScale = volumeScale;
  for (const [id, entity] of emitters) {
    entity.setValue(AudioSource, "volume", SFX_CATALOG[id].volume * volumeScale);
  }
}

/**
 * Start the ambient beds.
 *
 * Idempotent: `PlaybackMode.Ignore` means a second call while playing is a
 * no-op rather than a restart, so this can be called on every match start
 * without cutting the bed off mid-breath.
 *
 * Faded in over two seconds — a bed that arrives instantly is heard arriving,
 * which is the one thing ambience must not do.
 */
export function startAmbience(): void {
  // Ambience is currently disabled (`AMBIENCE_IDS` is empty). Returning here
  // rather than falling through keeps `audioContextState()` off a path that
  // runs every frame while there is nothing to start.
  if (AMBIENCE_IDS.length === 0) return;
  if (ambiencePlaying) return;

  // **Do not latch into a context that will swallow the play.**
  //
  // A suspended `AudioContext` accepts `play()` and produces nothing. Latching
  // anyway made the beds silent for an entire 853-second session
  // (`console-logs/2026-08-29-Audio-Plan_phase5_full.log`): the match started at
  // t+12.2s, the context was still suspended, `ambiencePlaying` latched, and
  // the early return above meant it never tried again.
  //
  // One-shots do not have this problem — they never latch, so the next shot
  // retries by itself. Only the beds need to care.
  //
  // The trigger is worth knowing: that session entered XR through the browser's
  // own Enter XR pill (no `launch requested via=landing-button` in the log),
  // which does not credit a user gesture the way our button does. So this is
  // the *normal* path on a headset, not an edge case.
  //
  // "none" — no context yet — is treated the same. Any OTHER state proceeds:
  // an unexpected value must not be able to silence ambience permanently, which
  // is the failure being fixed.
  const state = audioContextState();
  if (state === "suspended" || state === "none") {
    reportAudioContextIfSuspended("ambience");
    return;
  }

  ambiencePlaying = true;
  for (const id of AMBIENCE_IDS) {
    const entity = emitters.get(id);
    if (!entity) continue;
    AudioUtils.play(entity, AMBIENCE_FADE_SECONDS);
  }
}

/** Stop the beds. Faded, for the same reason they fade in. */
export function stopAmbience(): void {
  if (!ambiencePlaying) return;
  ambiencePlaying = false;
  for (const id of AMBIENCE_IDS) {
    const entity = emitters.get(id);
    if (entity) AudioUtils.pause(entity, AMBIENCE_FADE_SECONDS);
  }
}

/**
 * Scenario reset: stop everything and forget the cooldowns.
 *
 * The emitters themselves are persistent and deliberately outside
 * `ScenarioObject`, so a reset never disposes them — same choice
 * `combatEffects.ts` makes for its slots.
 */
export function clearSfx(): void {
  for (const entity of emitters.values()) AudioUtils.stop(entity);
  lastPlayedAt.clear();
  // A bed left marked playing would make the next `startAmbience` a no-op and
  // the match would run silent.
  ambiencePlaying = false;
}

export class SfxSystem extends createSystem({}) {
  /**
   * Mirror the Settings knob into the emitters, on change only.
   *
   * A pull-and-compare rather than a subscription, matching how every other
   * system reads `DebugSettings` (`movement.ts:19`, `selection.ts:41`,
   * `wave.ts:944`). One `getValue` and a float compare per frame; the write
   * itself touches every emitter and runs only when the number actually moves.
   *
   * Reading the setting inside `playSfx` instead would put a component read on
   * a path that runs at combat rates, which is exactly what `volume` being
   * component data is meant to avoid.
   */
  update(): void {
    // Beds are DERIVED from match status, not started by whoever remembers to.
    //
    // They were hooked to `startMatch` and the result transition, and a Restart
    // goes through neither: `scenarioReset` calls `clearSfx()` (which stops the
    // beds) and then writes `status` directly, so nothing ever started them
    // again and the rest of the session ran silent. `startMatch` would not have
    // helped even if called — it returns early unless the status is
    // `awaiting-start`.
    //
    // Deriving from the status cannot be forgotten by a new code path, which
    // is the same reason `matchAcceptsCommands` is a predicate rather than a
    // flag each system maintains. Both calls are idempotent, so running this
    // every frame costs a status read.
    const status = boardState.waveSource?.getValue(MatchState, "status");
    if (status === "playing") startAmbience();
    else stopAmbience();

    const setting = boardState.debugSettings?.getValue(
      DebugSettings,
      "sfxVolume",
    );
    // `null` as well as `undefined`: the component reader returns null before
    // the singleton exists, and Math.min would coerce it to 0 — silencing the
    // bank for the first frames of every session.
    if (setting === undefined || setting === null) return;
    const scale = Math.max(0, Math.min(1, setting));
    if (scale === appliedScale) return;
    setSfxVolume(scale);
  }

  init(): void {
    for (const id of Object.keys(SFX_CATALOG) as SfxId[]) {
      const spec = sfxSpec(id);
      const entity = this.world
        .createTransformEntity(undefined, { persistent: true })
        .addComponent(AudioSource, {
          // The URL, byte-identical to the manifest entry — never the key.
          src: spec.url,
          volume: spec.volume * volumeScale,
          loop: spec.loop ?? false,
          autoplay: false,
          // Listener-relative; see the note above on Open Decision 1.
          positional: false,
          maxInstances: spec.voices,
          // Overlap where the clip expects concurrency, Restart where a repeat
          // should replace rather than layer.
          playbackMode: spec.loop
            ? // A second start must not restart a running bed.
              PlaybackMode.Ignore
            : spec.voices > 1
              ? PlaybackMode.Overlap
              : PlaybackMode.Restart,
        });
      entity.object3D!.name = `Sfx:${id}`;
      emitters.set(id, entity);
    }
  }
}
