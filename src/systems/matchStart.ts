import { VisibilityState, type World } from "@iwsdk/core";
import { MatchState, boardState } from "./state.js";

/**
 * The one place the match is released from `awaiting-start`.
 *
 * ## Why a gate exists at all
 *
 * Nothing used to wait for the player. `WaveSource.timer` ticked from the first
 * frame after `World.create()` resolved, so an unattended tab played itself and
 * lost — confirmed 2026-08-26 at `status: "defeat", commandCenterAlive: false`
 * with nobody in the headset. Any capture from a tab left open was measuring a
 * match that had already ended.
 *
 * ## Why more than one trigger
 *
 * There are three ways a player can begin, and all of them have to release the
 * gate or the game looks frozen:
 *
 * 1. The landing page's `ENTER VR` button — calls {@link startMatch} directly.
 * 2. The landing page's `Explore in browser` button — same call. RTSVR is
 *    playable flat, so a VR-only release would strand desktop players.
 * 3. **The browser's own `Enter XR` pill.** `xr.offer: "always"` means the
 *    headset can enter a session without ever touching our markup, which
 *    bypasses both buttons — hence {@link attachMatchStart}.
 *
 * Idempotent on purpose: several of these can fire for one entry, and a restart
 * that is already `playing` must not be knocked back to the start gate.
 */
export function startMatch(): boolean {
  const source = boardState.waveSource;
  if (!source) return false;
  const status = source.getValue(MatchState, "status") ?? "awaiting-start";
  if (status !== "awaiting-start") return false;
  source.setValue(MatchState, "status", "playing");
  source.setValue(
    MatchState,
    "revision",
    (source.getValue(MatchState, "revision") ?? 0) + 1,
  );
  return true;
}

/**
 * True while the app is loaded but the player has not begun.
 *
 * **Defaults to `true` when the wave source does not exist yet**, and that
 * direction is deliberate. No wave source means the board has not been built,
 * which is emphatically "not started" — and every caller does something
 * dangerous with `false`:
 *
 * - `TutorialSystem` would take the `goDormant(false)` branch, which calls
 *   `markTutorialLeft()` and **retires the tutorial for the whole match**.
 * - `setupLanding` would hide the landing page, leaving no way in.
 * - `MiningSystem` would let a miner work before the match exists.
 *
 * The ordering in `index.ts` currently makes the null case unreachable, but
 * that is a property of one call site rather than of this function.
 */
export function matchAwaitingStart(): boolean {
  const source = boardState.waveSource;
  if (!source) return true;
  return (source.getValue(MatchState, "status") ?? "") === "awaiting-start";
}

/**
 * True only while the match is actually running.
 *
 * The complement of "the match is over, or has not begun". Gameplay that
 * changes the world — commands, production, construction, mining — asks this
 * so it stops at both ends: **before** the player starts (`awaiting-start`)
 * and **after** victory or defeat, where units were still accepting orders and
 * factories were still finishing craft over a decided match.
 *
 * `restarting` is excluded too: a scenario reset is mid-teardown, and acting on
 * entities it is about to dispose is how dangling handles are made.
 *
 * **Not for UI.** The tablet must stay live when the match is over or the
 * player cannot press Restart — its handlers live in `TabletSystem`, which
 * deliberately does not consult this.
 */
export function matchAcceptsCommands(): boolean {
  const source = boardState.waveSource;
  if (!source) return false;
  return (source.getValue(MatchState, "status") ?? "") === "playing";
}

/**
 * Release the gate when an immersive session begins, whatever started it.
 *
 * `VisibilityState.NonImmersive` is the 2D preview; anything else means a
 * session is live. Subscribing rather than polling keeps this off the frame
 * path entirely — it fires at most a handful of times per session.
 */
export function attachMatchStart(world: World): void {
  world.visibilityState.subscribe((state) => {
    if (state === VisibilityState.NonImmersive) return;
    startMatch();
  });
}
