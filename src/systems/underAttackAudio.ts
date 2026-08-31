import {
  AudioSource,
  AudioUtils,
  PlaybackMode,
  createSystem,
  type Entity,
} from "@iwsdk/core";
import {
  audioContextState,
  reportAudioContextIfSuspended,
} from "./audioUnlock.js";
import {
  UNDER_ATTACK_ALARM_SRC,
  UNDER_ATTACK_ALARM_FADE_IN_SECONDS,
  UNDER_ATTACK_ALARM_FADE_OUT_SECONDS,
  UNDER_ATTACK_ALARM_HOLD_SECONDS,
  UNDER_ATTACK_ALERT_VOLUME,
  UNDER_ATTACK_ALARM_VOLUME,
  UNDER_ATTACK_STING_SRC,
  UNDER_ATTACK_STING_COMMAND_CENTER_VOLUME,
  UNDER_ATTACK_STING_VOLUME,
} from "./constants.ts";
import type { AlertCategory } from "./underAttackAlertRules.ts";
import { DebugSettings, TabletState, boardState } from "./state.js";

/**
 * Cue E — the only cue that works with the player's eyes somewhere else.
 *
 * Two non-positional sources: a one-shot sting on every accepted alert, and a
 * looping alarm reserved for the command center. Both follow `vangogh`'s
 * `MusicSystem`: persistent entities, `positional: false` so the sound plays
 * from the listener rather than a spot on the table, and nothing touched per
 * frame.
 *
 * Deliberately NOT copied: `space-station`'s klaxon re-fires `play()` every two
 * seconds as a "safety net in case looped audio isn't supported". `loop` is
 * supported (`AudioSystem` calls `audio.setLoop`), and that re-fire restarts
 * the sound on a fixed cadence — the exact stutter this cue exists to avoid.
 */

let sting: Entity | null = null;
let alarm: Entity | null = null;
let alarmPlaying = false;
/** Seconds of quiet remaining before the command-center alarm fades out. */
let alarmHold = 0;
let audioEnabled = true;
/** Seconds to wait before deciding a clip is never going to load. */
const AUDIO_LOAD_CHECK_SECONDS = 8;
let loadCheck = 0;
let loadCheckDone = false;

function alertVolumeScale(): number {
  const setting =
    (boardState.debugSettings?.getValue(
      DebugSettings,
      "underAttackAlertVolume",
    ) as number | undefined) ?? UNDER_ATTACK_ALERT_VOLUME;
  return Math.min(1, Math.max(0, setting));
}

function scaledAlertVolume(volume: number): number {
  return volume * alertVolumeScale();
}

/** One-shot, fired on an accepted alert — never on a raw damage tick. */
export function playAlertSting(category: AlertCategory): void {
  if (!audioEnabled || !sting) return;
  sting.setValue(
    AudioSource,
    "volume",
    scaledAlertVolume(
      category === "command-center"
        ? UNDER_ATTACK_STING_COMMAND_CENTER_VOLUME
        : UNDER_ATTACK_STING_VOLUME,
    ),
  );
  reportAudioContextIfSuspended("under-attack sting");
  AudioUtils.play(sting);
}

/**
 * Called on every non-fatal command-center hit, alert or not. The first call
 * starts the loop; later calls only push the hold window forward, so a
 * sustained assault is one continuous alarm instead of a fade-in per hit.
 */
export function holdCommandCenterAlarm(): void {
  // The hold window refreshes even when the audio cannot start, so a sustained
  // assault still ends the alarm at the right moment once it does.
  alarmHold = UNDER_ATTACK_ALARM_HOLD_SECONDS;
  if (!audioEnabled || !alarm || alarmPlaying) return;

  // Do not latch into a context that will swallow the play.
  //
  // A suspended `AudioContext` accepts `play()` and produces nothing, so
  // setting `alarmPlaying` first loses the alarm. Less damaging here than for
  // the ambient beds, which latched the same way and stayed silent for an
  // entire 853-second session (`sfx.ts`, `startAmbience`): this one self-heals,
  // because `stopAlertAudio` clears the latch when the hold expires and the
  // next hit tries again. It still costs one whole alarm.
  //
  // Worth fixing because the trigger is the ordinary headset path — entering XR
  // through the browser's own pill does not credit a user gesture the way the
  // landing button does, so the context is routinely suspended early in a
  // session, which is exactly when a first attack lands.
  //
  // Names what it REJECTS, never what it allows: an unexpected state must
  // proceed, or the guard re-creates the silence it exists to prevent.
  const contextState = audioContextState();
  if (contextState === "suspended" || contextState === "none") {
    reportAudioContextIfSuspended("under-attack alarm");
    return;
  }

  alarm.setValue(
    AudioSource,
    "volume",
    scaledAlertVolume(UNDER_ATTACK_ALARM_VOLUME),
  );
  alarmPlaying = true;
  AudioUtils.play(alarm, UNDER_ATTACK_ALARM_FADE_IN_SECONDS);
}

/** Hard stop for victory, defeat, and restart — no fade, no lingering wail. */
export function stopAlertAudio(): void {
  alarmHold = 0;
  if (!alarm) return;
  if (alarmPlaying) AudioUtils.stop(alarm);
  alarmPlaying = false;
}

/** Single gate for both sources, ready for a debug-settings toggle. */
export function setAlertAudioEnabled(enabled: boolean): void {
  audioEnabled = enabled;
  if (!enabled) stopAlertAudio();
}

export class UnderAttackAudioSystem extends createSystem({}) {
  init(): void {
    // `src` values are URLs matching the manifest entries exactly, so the
    // preloaded buffer is reused. Passing the manifest key instead fails to
    // resolve and decodes index.html — see the note on the constants.
    sting = this.world
      .createTransformEntity(undefined, { persistent: true })
      .addComponent(AudioSource, {
        src: UNDER_ATTACK_STING_SRC,
        volume: scaledAlertVolume(UNDER_ATTACK_STING_VOLUME),
        loop: false,
        autoplay: false,
        positional: false,
        maxInstances: 1,
        playbackMode: PlaybackMode.Restart,
      });
    sting.object3D!.name = "UnderAttackSting";

    alarm = this.world
      .createTransformEntity(undefined, { persistent: true })
      .addComponent(AudioSource, {
        src: UNDER_ATTACK_ALARM_SRC,
        volume: scaledAlertVolume(UNDER_ATTACK_ALARM_VOLUME),
        loop: true,
        autoplay: false,
        positional: false,
        maxInstances: 1,
        playbackMode: PlaybackMode.Ignore,
      });
    alarm.object3D!.name = "UnderAttackAlarm";
  }

  update(delta: number): void {
    const frameDelta = Math.max(0, delta);
    this.reportLoadFailureOnce(frameDelta);
    if (alarm) {
      alarm.setValue(
        AudioSource,
        "volume",
        scaledAlertVolume(UNDER_ATTACK_ALARM_VOLUME),
      );
    }
    if (!alarmPlaying || alarmHold <= 0) return;
    alarmHold -= frameDelta;
    if (alarmHold > 0) return;
    AudioUtils.pause(alarm!, UNDER_ATTACK_ALARM_FADE_OUT_SECONDS);
    alarmPlaying = false;
  }

  /**
   * A headset has no console. If a clip fails to decode on device, silence is
   * indistinguishable from "no attack happened yet", so say so on the tablet —
   * once, as a real error, not as a per-frame status write.
   */
  private reportLoadFailureOnce(delta: number): void {
    if (loadCheckDone || !sting || !alarm) return;
    loadCheck += delta;
    if (loadCheck < AUDIO_LOAD_CHECK_SECONDS) return;
    loadCheckDone = true;
    const stingLoaded = sting.getValue(AudioSource, "_loaded") ?? false;
    const alarmLoaded = alarm.getValue(AudioSource, "_loaded") ?? false;
    if (stingLoaded && alarmLoaded) return;
    const missing = [
      stingLoaded ? "" : "sting",
      alarmLoaded ? "" : "alarm",
    ]
      .filter((part) => part.length > 0)
      .join(" + ");
    console.warn(`[UnderAttackAudio] failed to load: ${missing}`);
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "status", `Alert audio failed to load (${missing})`);
    tablet.setValue(TabletState, "statusKind", "error");
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }
}
