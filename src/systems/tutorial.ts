import { DebugSettings, boardState } from "./state.js";
import { TUTORIAL_ENABLED } from "./tutorialCatalog.ts";

/**
 * Tutorial runtime.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * Phase 2 grows this into `TutorialSystem` (state singleton, card, arrow, wave
 * gate). Today it is only the enabled check, so the Settings-tab toggle has
 * something to drive.
 */

/**
 * Is the tutorial switched on right now?
 *
 * Reads `DebugSettings.tutorialEnabled` so the tablet's Settings tab can flip it
 * mid-session, falling back to the `TUTORIAL_ENABLED` default before the
 * singleton exists. Same relationship every other tunable has with its constant
 * (see `ALIEN_MOVE_SPEED` / `DebugSettings.alienMoveSpeed`).
 *
 * Note that `DebugSettings` is deliberately not cleared by scenario reset, so a
 * player who switches the tutorial off keeps it off across Restart within the
 * same session — which is what you want from a debug toggle.
 */
export function isTutorialEnabled(): boolean {
  const setting = boardState.debugSettings?.getValue(
    DebugSettings,
    "tutorialEnabled",
  );
  if (setting === undefined || setting === null) return TUTORIAL_ENABLED;
  return setting >= 0.5;
}
