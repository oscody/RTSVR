import { createSystem, type Entity } from "@iwsdk/core";
import {
  ALERT_SPOTTED_PRIORITY,
  ALERT_VISIBLE_SECONDS,
  ALERT_TARGET_COOLDOWN_SECONDS,
  alertCategoryFor,
  alertDetail,
  alertMessage,
  alertPriority,
  shouldRaiseAlert,
  shouldRaiseSpottedAlert,
  spottedDetail,
  spottedMessage,
  type AlertCategory,
  type AlertRequest,
  type AlertRuntime,
  type SpottedRequest,
  type SpottedRuntime,
} from "./underAttackAlertRules.ts";
import {
  SPOTTED_ALERT_GLOBAL_GAP_SECONDS,
  SPOTTED_ALERT_TARGET_COOLDOWN_SECONDS,
} from "./constants.ts";
import {
  Building,
  MatchState,
  Unit,
  UnderAttackAlertState,
  boardState,
} from "./state.js";
import {
  clearUnderAttackBanner,
  hideUnderAttackBanner,
  showUnderAttackBanner,
} from "./underAttackBanner.js";
import {
  holdCommandCenterAlarm,
  playAlertSting,
  stopAlertAudio,
} from "./underAttackAudio.js";
import { markThreatened, punchThreatBadge } from "./underAttackVfx.js";

/**
 * Owns alert lifetime and the anti-spam bookkeeping, and fans one accepted
 * alert out to the cues. The decisions themselves live in
 * `underAttackAlertRules.ts` so they stay testable; this file is the part that
 * needs a world.
 */

/** Prune the cooldown map once it grows past this. Entities die constantly. */
const COOLDOWN_PRUNE_THRESHOLD = 64;

const cooldownByTarget = new Map<number, number>();
/** Reused across notifications — this runs inside the damage path. */
const request: AlertRequest = {
  targetIndex: -1,
  category: "unit",
  displayKind: "",
  fatal: false,
  matchStatus: "playing",
};
const runtime: AlertRuntime = {
  activePriority: 0,
  activeUntil: 0,
  lastAlertAt: Number.NEGATIVE_INFINITY,
  lastTargetAlertAt: Number.NEGATIVE_INFINITY,
};

const spottedCooldownByTarget = new Map<number, number>();
const spottedRequest: SpottedRequest = {
  targetIndex: -1,
  category: "unit",
  displayKind: "",
  matchStatus: "playing",
};
const spottedRuntime: SpottedRuntime = {
  activeUntil: 0,
  lastSpottedAt: Number.NEGATIVE_INFINITY,
  lastTargetSpottedAt: Number.NEGATIVE_INFINITY,
};

let clock = 0;
let activeUntil = 0;
let lastSpottedAt = Number.NEGATIVE_INFINITY;

/**
 * Publish one hit on a friendly. Called from `CombatSystem.applyAttack()` after
 * damage lands, only when the attacker is an enemy.
 *
 * The attacker itself is no longer needed: it existed only to aim the rim
 * beacon, which was removed 2026-08-17.
 *
 * The target entity is never retained: it may be destroyed long before any cue
 * finishes, and entity indexes are recycled.
 */
export function notifyFriendlyDamage(target: Entity, fatal: boolean): void {
  const isBuilding = target.hasComponent(Building);
  const kind = isBuilding
    ? (target.getValue(Building, "kind") ?? "unknown")
    : (target.getValue(Unit, "kind") ?? "unknown");
  const category = alertCategoryFor(isBuilding, kind === "command-center");
  const status =
    boardState.waveSource?.getValue(MatchState, "status") ?? "playing";

  // Per-hit emphasis is independent of the alert: the badge is already on
  // screen, and flinching on every hit is what sells the damage.
  if (!fatal) punchThreatBadge(target);

  // The alarm's hold window is pushed by every command-center hit, not only by
  // accepted alerts — otherwise it would fade out mid-assault while the 8 s
  // per-target cooldown suppresses the alerts that would have renewed it.
  if (!fatal && status === "playing" && category === "command-center") {
    holdCommandCenterAlarm();
  }

  request.targetIndex = target.index;
  request.category = category;
  request.displayKind = kind;
  request.fatal = fatal;
  request.matchStatus = status;

  runtime.activePriority = activeUntil > clock ? runtime.activePriority : 0;
  runtime.activeUntil = activeUntil;
  runtime.lastTargetAlertAt =
    cooldownByTarget.get(target.index) ?? Number.NEGATIVE_INFINITY;
  if (!shouldRaiseAlert(request, runtime, clock)) return;

  raiseAlert(category, kind, target.index);
}

/** The one place `UnderAttackAlertState` is written on a raise. */
function publishAlertState(
  message: string,
  detail: string,
  priority: number,
  targetIndex: number,
): void {
  const alert = boardState.underAttackAlert;
  if (!alert) return;
  alert.setValue(UnderAttackAlertState, "active", true);
  alert.setValue(UnderAttackAlertState, "message", message);
  alert.setValue(UnderAttackAlertState, "detail", detail);
  alert.setValue(UnderAttackAlertState, "priority", priority);
  alert.setValue(UnderAttackAlertState, "targetIndex", targetIndex);
  alert.setValue(
    UnderAttackAlertState,
    "revision",
    (alert.getValue(UnderAttackAlertState, "revision") ?? 0) + 1,
  );
}

function raiseAlert(
  category: AlertCategory,
  displayKind: string,
  targetIndex: number,
): void {
  const message = alertMessage(category, displayKind);
  const detail = alertDetail(category);
  const priority = alertPriority(category);

  cooldownByTarget.set(targetIndex, clock);
  runtime.lastAlertAt = clock;
  runtime.activePriority = priority;
  activeUntil = clock + ALERT_VISIBLE_SECONDS;
  publishAlertState(message, detail, priority, targetIndex);

  playAlertSting(category);
  if (category === "command-center") {
    showUnderAttackBanner(message, detail);
  } else {
    // Real damage outranks a sighting, so retire any amber caution banner
    // rather than leave "UNIT DETECTED" up while something is being hit.
    hideUnderAttackBanner();
  }
}

/**
 * An alien has acquired a friendly. Owns the ⦾ threat badge and, on the
 * transition into "spotted", may raise the amber caution banner.
 *
 * Called from the enemy loop in `CombatSystem` for every alien with a target,
 * so the common path is one map write and an early return.
 */
export function notifyThreat(target: Entity): void {
  if (!markThreatened(target)) return;

  const isBuilding = target.hasComponent(Building);
  const kind = isBuilding
    ? (target.getValue(Building, "kind") ?? "unknown")
    : (target.getValue(Unit, "kind") ?? "unknown");
  const category = alertCategoryFor(isBuilding, kind === "command-center");

  spottedRequest.targetIndex = target.index;
  spottedRequest.category = category;
  spottedRequest.displayKind = kind;
  spottedRequest.matchStatus =
    boardState.waveSource?.getValue(MatchState, "status") ?? "playing";

  spottedRuntime.activeUntil = activeUntil;
  spottedRuntime.lastSpottedAt = lastSpottedAt;
  spottedRuntime.lastTargetSpottedAt =
    spottedCooldownByTarget.get(target.index) ?? Number.NEGATIVE_INFINITY;
  if (
    !shouldRaiseSpottedAlert(
      spottedRequest,
      spottedRuntime,
      clock,
      SPOTTED_ALERT_GLOBAL_GAP_SECONDS,
      SPOTTED_ALERT_TARGET_COOLDOWN_SECONDS,
    )
  ) {
    return;
  }

  const message = spottedMessage();
  const detail = spottedDetail(category, kind);
  spottedCooldownByTarget.set(target.index, clock);
  lastSpottedAt = clock;
  runtime.activePriority = ALERT_SPOTTED_PRIORITY;
  activeUntil = clock + ALERT_VISIBLE_SECONDS;
  publishAlertState(message, detail, ALERT_SPOTTED_PRIORITY, target.index);
  // Amber, and silent: being seen is a warning you can still act on, and a
  // sting on every sighting would be constant noise. No rim flash either —
  // that is reserved for damage to the command center.
  showUnderAttackBanner(message, detail, "caution");
}

/** Restart clears the visible alert AND every cooldown, in both directions. */
export function resetUnderAttackAlert(): void {
  cooldownByTarget.clear();
  spottedCooldownByTarget.clear();
  lastSpottedAt = Number.NEGATIVE_INFINITY;
  runtime.activePriority = 0;
  runtime.lastAlertAt = Number.NEGATIVE_INFINITY;
  runtime.lastTargetAlertAt = Number.NEGATIVE_INFINITY;
  activeUntil = 0;
  clearUnderAttackBanner();
  stopAlertAudio();
  const alert = boardState.underAttackAlert;
  if (!alert) return;
  alert.setValue(UnderAttackAlertState, "active", false);
  alert.setValue(UnderAttackAlertState, "message", "");
  alert.setValue(UnderAttackAlertState, "detail", "");
  alert.setValue(UnderAttackAlertState, "priority", 0);
  alert.setValue(UnderAttackAlertState, "targetIndex", -1);
  alert.setValue(
    UnderAttackAlertState,
    "revision",
    (alert.getValue(UnderAttackAlertState, "revision") ?? 0) + 1,
  );
}

export class UnderAttackAlertSystem extends createSystem({}) {
  private lastStatus = "playing";

  init(): void {
    const alert = this.world
      .createTransformEntity(undefined, { persistent: true })
      .addComponent(UnderAttackAlertState);
    alert.object3D!.name = "UnderAttackAlertState";
    boardState.underAttackAlert = alert;
  }

  update(delta: number): void {
    clock += Math.max(0, delta);

    const status =
      boardState.waveSource?.getValue(MatchState, "status") ?? "playing";
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      // Victory, defeat and restart all end the emergency immediately — a
      // warning that outlives the match is just noise.
      if (status !== "playing") {
        stopAlertAudio();
        hideUnderAttackBanner();
        this.expire();
      }
    }

    if (activeUntil > 0 && clock >= activeUntil) this.expire();
    if (
      cooldownByTarget.size > COOLDOWN_PRUNE_THRESHOLD ||
      spottedCooldownByTarget.size > COOLDOWN_PRUNE_THRESHOLD
    ) {
      this.pruneCooldowns();
    }
  }

  /** One write on the transition, never a per-frame countdown. */
  private expire(): void {
    if (activeUntil <= 0) return;
    activeUntil = 0;
    runtime.activePriority = 0;
    const alert = boardState.underAttackAlert;
    if (!alert) return;
    alert.setValue(UnderAttackAlertState, "active", false);
    alert.setValue(
      UnderAttackAlertState,
      "revision",
      (alert.getValue(UnderAttackAlertState, "revision") ?? 0) + 1,
    );
  }

  private pruneCooldowns(): void {
    for (const [index, at] of cooldownByTarget) {
      if (clock - at >= ALERT_TARGET_COOLDOWN_SECONDS) {
        cooldownByTarget.delete(index);
      }
    }
    for (const [index, at] of spottedCooldownByTarget) {
      if (clock - at >= SPOTTED_ALERT_TARGET_COOLDOWN_SECONDS) {
        spottedCooldownByTarget.delete(index);
      }
    }
  }
}
