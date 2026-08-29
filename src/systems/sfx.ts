import { AudioSource, AudioUtils, PlaybackMode, createSystem } from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";
import { reportAudioContextIfSuspended } from "./audioUnlock.js";
import { SFX_CATALOG, type SfxId } from "./sfxCatalog.js";

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

let sfxEnabled = true;
let volumeScale = 1;

/**
 * Play a one-shot.
 *
 * Safe to call from anywhere, including before the system has initialized —
 * a missing emitter is a silent no-op, never a throw. Audio must never be able
 * to take down a frame.
 */
export function playSfx(id: SfxId): void {
  if (!sfxEnabled) return;
  const entity = emitters.get(id);
  if (!entity) return;

  const spec = SFX_CATALOG[id];
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

/** Single gate, matching `setAlertAudioEnabled`. Ready for a settings toggle. */
export function setSfxEnabled(enabled: boolean): void {
  sfxEnabled = enabled;
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
  for (const [id, entity] of emitters) {
    entity.setValue(AudioSource, "volume", SFX_CATALOG[id].volume * volumeScale);
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
}

export class SfxSystem extends createSystem({}) {
  init(): void {
    for (const id of Object.keys(SFX_CATALOG) as SfxId[]) {
      const spec = SFX_CATALOG[id];
      const entity = this.world
        .createTransformEntity(undefined, { persistent: true })
        .addComponent(AudioSource, {
          // The URL, byte-identical to the manifest entry — never the key.
          src: spec.url,
          volume: spec.volume * volumeScale,
          loop: false,
          autoplay: false,
          // Listener-relative; see the note above on Open Decision 1.
          positional: false,
          maxInstances: spec.voices,
          // Overlap where the clip expects concurrency, Restart where a repeat
          // should replace rather than layer.
          playbackMode:
            spec.voices > 1 ? PlaybackMode.Overlap : PlaybackMode.Restart,
        });
      entity.object3D!.name = `Sfx:${id}`;
      emitters.set(id, entity);
    }
  }
}
