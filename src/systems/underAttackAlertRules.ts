import { getBuildingSpec } from "./buildingCatalog.ts";
import { getProductionSpec } from "./craftCatalog.ts";

/**
 * Pure decision layer for under-attack alerting.
 *
 * Everything here is IWSDK-free so the anti-spam behaviour — the part that is
 * genuinely easy to get wrong and impossible to eyeball in a headset — can be
 * pinned by tests without constructing an XR world.
 */

export type AlertCategory = "unit" | "building" | "command-center";

export const ALERT_PRIORITY: Readonly<Record<AlertCategory, number>> = {
  unit: 1,
  building: 2,
  "command-center": 3,
};

export const COMMAND_CENTER_PRIORITY = ALERT_PRIORITY["command-center"];

/** How long one accepted alert stays up. */
export const ALERT_VISIBLE_SECONDS = 3;
/** Minimum spacing between two alerts of ordinary priority. */
export const ALERT_GLOBAL_GAP_SECONDS = 2;
/** A target that is already screaming does not scream again this soon. */
export const ALERT_TARGET_COOLDOWN_SECONDS = 8;

export interface AlertRequest {
  /** Entity index of the victim. Never hold the entity — it may die first. */
  targetIndex: number;
  category: AlertCategory;
  /** `Building.kind` / `Unit.kind`, used only to pick a display name. */
  displayKind: string;
  /** Fatal hits raise nothing; destruction messaging is more accurate. */
  fatal: boolean;
  matchStatus: string;
}

export interface AlertRuntime {
  /** Priority of the alert currently on screen, or 0 when nothing is up. */
  activePriority: number;
  /** Clock time the active alert expires at. */
  activeUntil: number;
  /** Clock time of the most recent accepted alert, any target. */
  lastAlertAt: number;
  /** Clock time this specific target last raised an alert. */
  lastTargetAlertAt: number;
}

export function alertPriority(category: AlertCategory): number {
  return ALERT_PRIORITY[category];
}

/** Player-facing name for the victim. Never an ECS index or an asset name. */
export function alertDisplayName(
  category: AlertCategory,
  displayKind: string,
): string {
  if (category === "command-center") return "Command center";
  const building = getBuildingSpec(displayKind);
  if (building) return building.label;
  const craft = getProductionSpec(displayKind);
  if (craft) return craft.label;
  if (!displayKind) return category === "building" ? "Building" : "Unit";
  return displayKind.charAt(0).toUpperCase() + displayKind.slice(1);
}

export function alertMessage(
  category: AlertCategory,
  displayKind: string,
): string {
  return `${alertDisplayName(category, displayKind)} under attack`;
}

/** One-line subtitle for the command-center banner. */
export function alertDetail(category: AlertCategory): string {
  return category === "command-center"
    ? "Multiple enemy units detected."
    : "Enemy contact on the board.";
}

/**
 * The whole anti-spam policy in one place.
 *
 * Order matters: suppression beats priority. A command-center hit outranks
 * everything on screen, but it still cannot fire during its own per-target
 * cooldown, or the alarm would retrigger on every damage tick of a sustained
 * assault — which is exactly the failure this feature exists to avoid.
 */
export function shouldRaiseAlert(
  request: AlertRequest,
  runtime: AlertRuntime,
  now: number,
): boolean {
  if (request.fatal) return false;
  if (request.matchStatus !== "playing") return false;
  if (now - runtime.lastTargetAlertAt < ALERT_TARGET_COOLDOWN_SECONDS) {
    return false;
  }

  const priority = alertPriority(request.category);
  const alertVisible = now < runtime.activeUntil;
  if (alertVisible) return priority > runtime.activePriority;
  // Nothing on screen: the command center jumps the queue, everything else
  // waits out the global gap so a swarm cannot machine-gun the cues.
  if (priority >= COMMAND_CENTER_PRIORITY) return true;
  return now - runtime.lastAlertAt >= ALERT_GLOBAL_GAP_SECONDS;
}

/**
 * Priority of a "spotted" alert — below every damage alert, so a friendly
 * actually being hit always takes the banner from a friendly merely being seen.
 */
export const ALERT_SPOTTED_PRIORITY = 0;

export interface SpottedRequest {
  targetIndex: number;
  category: AlertCategory;
  displayKind: string;
  matchStatus: string;
}

export interface SpottedRuntime {
  /** Clock time the currently visible alert expires at, whatever raised it. */
  activeUntil: number;
  /** Clock time of the most recent accepted spotted alert, any target. */
  lastSpottedAt: number;
  /** Clock time this specific target last raised a spotted alert. */
  lastTargetSpottedAt: number;
}

export function spottedMessage(): string {
  return "Unit detected";
}

export function spottedDetail(
  category: AlertCategory,
  displayKind: string,
): string {
  return `Aliens have spotted your ${alertDisplayName(category, displayKind)}.`;
}

/**
 * Acceptance for a spotted alert. Deliberately meeker than
 * {@link shouldRaiseAlert}: it never interrupts a visible alert of any kind,
 * because "something is looking at you" must never bump "something is hitting
 * you" off the screen.
 */
export function shouldRaiseSpottedAlert(
  request: SpottedRequest,
  runtime: SpottedRuntime,
  now: number,
  globalGapSeconds: number,
  targetCooldownSeconds: number,
): boolean {
  if (request.matchStatus !== "playing") return false;
  if (now < runtime.activeUntil) return false;
  if (now - runtime.lastSpottedAt < globalGapSeconds) return false;
  if (now - runtime.lastTargetSpottedAt < targetCooldownSeconds) return false;
  return true;
}

/** Classify a damage victim. `isCommandCenter` comes from `Building.kind`. */
export function alertCategoryFor(
  isBuilding: boolean,
  isCommandCenter: boolean,
): AlertCategory {
  if (isCommandCenter) return "command-center";
  return isBuilding ? "building" : "unit";
}
