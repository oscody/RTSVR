import { AudioSystem, type World } from "@iwsdk/core";

/**
 * Makes sure the Web Audio context is actually running before anything tries to
 * play through it.
 *
 * **Why this is needed when the SDK already resumes.** `AudioSystem` resumes the
 * context on XR session start (`audio-system.js:39`), but browsers only honour a
 * resume that happens inside a **user gesture**, and a session-start event is not
 * reliably credited as one. The console shows the refusal:
 *
 * > The AudioContext was not allowed to start. It must be resumed (or created)
 * > after a user gesture on the page.
 *
 * Nothing in the app tried again — `resume()` appeared nowhere in `src/` — so a
 * context that lost that race stayed suspended for the whole session. That is not
 * a cosmetic problem: `underAttackAudio.ts` plays the sting and the looping alarm
 * that tell the player their command center is being destroyed. A safety cue that
 * may or may not play, depending on whether the browser credited a gesture, is
 * worse than one that is deliberately switched off.
 *
 * Found in `devlog/plan/2026-08-20-Console-Log-Review-And-Optimisation-Plan.md`,
 * Finding 4.
 */

/**
 * The private field on `AudioSystem` that owns the context.
 *
 * Reaching past `private` is deliberate and narrow. `AudioSystem` is exported by
 * `@iwsdk/core` and its listener is the **only** handle on the context this app
 * can reach — three's `AudioContext` singleton is not re-exported, and the
 * project rule is never to import from `three` directly. Typed as narrowly as
 * possible so a change in the SDK breaks here loudly rather than silently.
 */
interface AudioSystemWithListener {
  listener?: { context?: AudioContext };
}

let audioWorld: World | null = null;
/** One-shot: the unlock listeners detach as soon as a resume succeeds. */
let unlocked = false;
/** So a suspended context is reported once, not on every alarm. */
let warnedSuspended = false;

function contextOf(): AudioContext | null {
  if (!audioWorld) return null;
  const system = audioWorld.getSystem(
    AudioSystem,
  ) as unknown as AudioSystemWithListener | null;
  return system?.listener?.context ?? null;
}

const GESTURES = ["pointerdown", "click", "keydown", "touchstart"] as const;

function onGesture(): void {
  const context = contextOf();
  if (!context) return;
  if (context.state !== "suspended") {
    detach();
    return;
  }
  void context
    .resume()
    .then(() => {
      if (context.state === "running") {
        warnedSuspended = false;
        detach();
      }
    })
    .catch(() => {
      // Still not allowed. Keep the listeners attached and try on the next
      // gesture rather than giving up — the first click of a session is
      // sometimes consumed by the XR entry flow itself.
    });
}

function detach(): void {
  if (unlocked) return;
  unlocked = true;
  for (const type of GESTURES) {
    window.removeEventListener(type, onGesture, true);
  }
}

/**
 * Call once from `index.ts`, after `World.create` resolves.
 *
 * Capture-phase listeners on `window` so the resume happens on the *first* user
 * gesture of the page — including the click that enters XR, which unlocks the
 * context before the session even starts.
 */
export function attachAudioUnlock(world: World): void {
  audioWorld = world;
  unlocked = false;
  for (const type of GESTURES) {
    window.addEventListener(type, onGesture, true);
  }
}

/**
 * Report once if audio is played while the context is suspended.
 *
 * The failure this guards against is **silent in both senses**: no sound, and
 * no error. Without this, "the alarm did not play" and "the alarm played at zero
 * volume" look identical from the outside — and the volume knob
 * (`DebugSettings.underAttackAlertVolume`) makes the second genuinely possible.
 */
export function reportAudioContextIfSuspended(label: string): void {
  if (warnedSuspended) return;
  const context = contextOf();
  if (!context || context.state !== "suspended") return;
  warnedSuspended = true;
  console.warn(
    `[Audio] "${label}" was played while the AudioContext is SUSPENDED, so nothing will be heard. ` +
      "The browser has not credited a user gesture yet — click or press a trigger once. " +
      "(Reported once per session; see audioUnlock.ts)",
  );
}

/** Current context state, for diagnostics from the CLI or a test. */
export function audioContextState(): string {
  return contextOf()?.state ?? "none";
}
