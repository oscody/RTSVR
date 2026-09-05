import { VisibilityState, type World } from "@iwsdk/core";
import { ActionKind, logAction } from "./actionLog.js";
import { MatchState, boardState } from "./state.js";
import { resetWaveTransitionLog } from "./waveTransitionLog.js";

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
 * Both remaining ways in are immersive, and both have to release the gate or
 * the game looks frozen:
 *
 * 1. The landing page's `ENTER VR` button — requests the session and lets the
 *    visibility change release the gate, never calling {@link startMatch}
 *    itself. See the comment on that handler for why.
 * 2. **The browser's own `Enter XR` pill.** `xr.offer: "always"` means the
 *    headset can enter a session without ever touching our markup, which
 *    bypasses the button — hence {@link attachMatchStart}.
 *
 * **There is deliberately no flat route.** An `Explore in browser` button
 * existed and released the gate with `via=landing-explore`; it was removed
 * 2026-09-05 on request. The consequence is real and intended: a machine
 * without a headset can now load the page and cannot begin. Anything below
 * that still describes a desktop start is describing history — the frame-order
 * bug in `wave.ts` was measured on that route and its guard is kept, because
 * the guard is about a stale tutorial gate rather than about which button was
 * pressed.
 *
 * Idempotent on purpose: several of these can fire for one entry, and a restart
 * that is already `playing` must not be knocked back to the start gate.
 */
export function startMatch(via = "unknown"): boolean {
  const source = boardState.waveSource;
  if (!source) return false;
  const status = source.getValue(MatchState, "status") ?? "awaiting-start";
  if (status !== "awaiting-start") return false;
  logAction(ActionKind.MatchStart, `awaiting-start -> playing via=${via}`);
  // Wave 1 is timed from here, not from page load. Without this the first
  // transition would report however long the player spent on the landing page.
  resetWaveTransitionLog();
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
 * Last status each named system was blocked by, so a refusal logs on the edge.
 *
 * **This must be edge-triggered or it is unusable.** Three of the four callers
 * ask on every frame, so an unconditional line would be ~360 a second — the
 * exact "mechanism, not decision" flood the action log exists to avoid.
 *
 * Suppressing it *here* rather than in `logAction` is the rule learned on
 * 2026-08-27: the sink cannot tell an action from a state, but this function
 * can. "The match is over" is a **state**, so it prints once per episode; a
 * player pressing Produce twice is two **actions**, so those print twice.
 */
const blockedBy = new Map<string, string>();

/**
 * The statuses that mean "the match is decided".
 *
 * Deliberately **not** every non-playing status — see the filter in
 * {@link matchAcceptsCommands}. `tutorialDeadEnd` is absent because it is a
 * `MatchState` value the tutorial sets, never a `MatchStatus`, and the gate
 * reads the latter.
 */
const MATCH_OVER: ReadonlySet<string> = new Set(["victory", "defeat"]);

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
 *
 * @param system Optional name. Passing one makes the refusal **observable**:
 * the first frame this system is blocked, and again whenever the blocking
 * status changes, it logs `[Action] blocked <system> status=<status>`.
 *
 * Why it was worth adding: on 2026-08-27 a session ended in victory and the
 * board went quiet — but with **no miners, nothing in production, nothing under
 * construction and no wave 7**, the quiet was over-determined. *With every gate
 * removed that board would have looked identical.* Four of the five gates were
 * bare `return`s that no log could see, so the ✅ rested on a single manual
 * check. A named gate reports itself.
 *
 * Re-arms automatically: when the match returns to `playing` the record clears,
 * so a restart logs the next block afresh rather than staying silent.
 */
export function matchAcceptsCommands(system?: string): boolean {
  const source = boardState.waveSource;
  const status = source
    ? ((source.getValue(MatchState, "status") ?? "") as string)
    : "no-board";
  const accepts = status === "playing";
  if (system !== undefined) {
    // Only a DECIDED match is reported. `awaiting-start` and `restarting` also
    // block, but both already have their own narrative line
    // (`match awaiting-start -> playing`, `restart scenario reset requested`),
    // and reporting them would add four lines at every boot and four more at
    // every restart — roughly a 40% longer narrative, none of it new. "" is the
    // re-armed state and is never logged; only the edge INTO a decided match is.
    const now = MATCH_OVER.has(status) ? status : "";
    if (blockedBy.get(system) !== now) {
      blockedBy.set(system, now);
      if (now !== "") {
        logAction(ActionKind.Blocked, `${system} status=${now}`);
      }
    }
  }
  return accepts;
}


/**
 * Release the gate when an immersive session begins, whatever started it.
 *
 * `VisibilityState.NonImmersive` is the 2D preview; anything else means a
 * session is live. Subscribing rather than polling keeps this off the frame
 * path entirely — it fires at most a handful of times per session.
 */
export function attachMatchStart(world: World): void {
  // `subscribe` fires IMMEDIATELY with the current value, and at boot that is
  // always NonImmersive — so logging an exit unconditionally reported leaving a
  // session that had never been entered, once per page load. Same shape as the
  // tutorial's spurious boot line: an edge log must see a real edge.
  let wasImmersive = false;
  world.visibilityState.subscribe((state) => {
    const immersive = state !== VisibilityState.NonImmersive;
    if (!immersive) {
      if (wasImmersive) logAction(ActionKind.Xr, "exit -> non-immersive");
      wasImmersive = false;
      return;
    }
    if (!wasImmersive) logAction(ActionKind.Xr, `enter state=${String(state)}`);
    wasImmersive = true;
    startMatch("xr-session");
  });
}
