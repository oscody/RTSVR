/**
 * Every identifier the trace stores as a NUMBER, with the name tables used to
 * turn it back into text at export time.
 *
 * No imports, same rule as `traceFlags.ts`.
 *
 * **Why numbers.** A trace event has to be writable on the frame a hitch is
 * happening without allocating, so an event is eight slots in eight
 * preallocated typed arrays and every field is an integer. Strings are built
 * exactly once, in `formatEvent`, and only for the few thousand events a dump
 * actually prints. A template literal in the record path would allocate on
 * every damage tick, which is the failure mode the profiler's own `Prof` line
 * exists to catch — a diagnostic becoming the thing it is measuring.
 *
 * **Why the values are written out rather than auto-numbered.** They appear in
 * saved console captures. A capture from today has to stay readable against the
 * name tables of next month, so an id is never reused for a different meaning:
 * add at the end, and leave a retired id's entry in place with its old name.
 */

// ---------------------------------------------------------------------------
// Event kinds — what the record IS.
// ---------------------------------------------------------------------------

export const TraceKind = {
  Read: 1,
  Write: 2,
  Decision: 3,
  StateChange: 4,
  EntityCreated: 5,
  EntityTransition: 6,
  EntityDestroyed: 7,
  Skipped: 8,
  ContractPass: 9,
  ContractFail: 10,
  Error: 11,
  Interaction: 12,
  Runtime: 13,
  /** A system did not run at all this frame (paused, or absent). */
  SystemAbsent: 14,
  /** A system's `update()` threw; the original error is rethrown. */
  SystemThrew: 15,
  /** Startup snapshot: the system id / name / registration-index map. */
  SystemMap: 16,
  /** A dump trigger fired. Always the last event in a preserved snapshot. */
  Trigger: 17,
} as const;
export type TraceKindId = (typeof TraceKind)[keyof typeof TraceKind];

const KIND_NAMES: Readonly<Record<number, string>> = {
  1: "READ",
  2: "WRITE",
  3: "DECISION",
  4: "STATE",
  5: "CREATED",
  6: "TRANSITION",
  7: "DESTROYED",
  8: "SKIPPED",
  9: "CONTRACT-PASS",
  10: "CONTRACT-FAIL",
  11: "ERROR",
  12: "INTERACTION",
  13: "RUNTIME",
  14: "SYSTEM-ABSENT",
  15: "SYSTEM-THREW",
  16: "SYSTEM-MAP",
  17: "TRIGGER",
};

export function kindName(kind: number): string {
  return KIND_NAMES[kind] ?? `KIND-${kind}`;
}

// ---------------------------------------------------------------------------
// Reason ids — WHY. Shared by decisions, skips, rejections and triggers, so one
// table answers "what happened" for every kind of record.
// ---------------------------------------------------------------------------

export const Reason = {
  None: 0,

  // --- normal, expected decisions. These must NEVER trigger a dump. --------
  ActiveCapReached: 1,
  NoReserveReady: 2,
  TutorialBudgetSpent: 3,
  TutorialHoldsCountdown: 4,
  NoEligibleTarget: 5,
  NotAffordable: 6,
  AlertFilteredCooldown: 7,
  AlertFilteredPriority: 8,
  AlertFilteredFatal: 9,
  AlertFilteredMatchOver: 10,
  MatchNotPlaying: 11,
  WaveNotActive: 12,
  TutorialFrozen: 13,
  NothingSelected: 14,
  BuildingCannotProduce: 15,
  TileUnavailable: 16,
  NoPathToSite: 17,
  ItemLocked: 18,
  TutorialWantsSomethingElse: 19,
  NoBuildToCancel: 20,
  NoWaveSpec: 21,
  AlreadySpawned: 22,
  TutorialDormant: 23,
  NoSource: 24,
  NoBuilder: 25,
  ResourceExhausted: 26,
  BaseUnavailable: 27,

  // --- accepted outcomes --------------------------------------------------
  Released: 40,
  Accepted: 41,
  Completed: 42,
  Cancelled: 43,
  Refunded: 44,
  Killed: 45,
  Deposited: 46,
  Placed: 47,
  Queued: 48,
  Assigned: 49,
  Restarted: 50,

  // --- failures. These DO trigger a dump. ---------------------------------
  CapViolated: 80,
  ActivationInInvalidStage: 81,
  PreparationFailed: 82,
  ReleaseFailed: 83,
  ResetFailed: 84,
  InvalidLifecycle: 85,
  ContractTimingMissed: 86,
  SystemError: 87,
  InteractionLost: 88,
  InteractionTimeout: 89,
  WaitingAlienAttached: 90,
  WaitingAlienVisible: 91,
  ResetLeftResidue: 92,
  PathfindingFailed: 93,

  // --- runtime / attribution triggers -------------------------------------
  HitchFrame: 110,
  OtherGap: 111,
  LongTaskOverlap: 112,
  ShaderOperationSlow: 113,
  XrTransitionDuringHitch: 114,
  ManualDump: 115,
} as const;
export type ReasonId = (typeof Reason)[keyof typeof Reason];

const REASON_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "active cap reached",
  2: "no reserve ready",
  3: "tutorial budget spent",
  4: "tutorial holds countdown",
  5: "no eligible target",
  6: "not affordable",
  7: "alert filtered: target cooldown",
  8: "alert filtered: lower priority",
  9: "alert filtered: fatal hit",
  10: "alert filtered: match over",
  11: "match not playing",
  12: "wave not active",
  13: "tutorial frozen",
  14: "nothing selected",
  15: "building cannot produce",
  16: "tile unavailable",
  17: "no path to site",
  18: "item locked",
  19: "tutorial wants something else",
  20: "no build to cancel",
  21: "no wave spec",
  22: "wave already spawned",
  23: "tutorial dormant",
  24: "no source singleton",
  25: "no builder attached",
  26: "resource exhausted",
  27: "base unavailable",
  40: "released",
  41: "accepted",
  42: "completed",
  43: "cancelled",
  44: "refunded",
  45: "killed",
  46: "deposited",
  47: "placed",
  48: "queued",
  49: "assigned",
  50: "restarted",
  80: "CAP VIOLATED",
  81: "ACTIVATION IN INVALID STAGE",
  82: "PREPARATION FAILED",
  83: "RELEASE FAILED",
  84: "RESET FAILED",
  85: "INVALID LIFECYCLE TRANSITION",
  86: "CONTRACT TIMING MISSED",
  87: "SYSTEM THREW",
  88: "INTERACTION LOST",
  89: "INTERACTION TIMEOUT",
  90: "WAITING ALIEN STILL ATTACHED",
  91: "WAITING ALIEN VISIBLE",
  92: "RESET LEFT RESIDUE",
  93: "PATHFINDING FAILED",
  110: "hitch frame",
  111: "Other gap",
  112: "long task overlapping hitch",
  113: "slow shader operation",
  114: "XR transition during hitch",
  115: "manual dump",
};

export function reasonName(reason: number): string {
  return REASON_NAMES[reason] ?? `reason-${reason}`;
}

/**
 * Reasons that describe a normal decision and must never preserve a snapshot.
 *
 * Written as an explicit set rather than "anything below 80", so that adding a
 * reason in the wrong numeric band produces a dump storm in testing instead of
 * silently suppressing a real failure. Everything not listed here is treated as
 * dump-worthy only when the caller says so.
 */
export function isExpectedDecision(reason: number): boolean {
  return reason > 0 && reason < 80;
}

/** Reasons that always preserve a snapshot, whatever the caller asked for. */
export function isFailureReason(reason: number): boolean {
  return reason >= 80 && reason < 110;
}

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

export const EntityKind = {
  Unknown: 0,
  AlienWalker: 1,
  AlienDrake: 2,
  AlienMech: 3,
  Astronaut: 4,
  Miner: 5,
  Fighter: 6,
  Rover: 7,
  CommandCenter: 8,
  Turret: 9,
  Hangar: 10,
  Factory: 11,
  ConstructionSite: 12,
  CraftProductionSite: 13,
  ResourceNode: 14,
  Meteor: 15,
  Building: 16,
} as const;
export type EntityKindId = (typeof EntityKind)[keyof typeof EntityKind];

const ENTITY_KIND_NAMES: Readonly<Record<number, string>> = {
  0: "unknown",
  1: "walker",
  2: "drake",
  3: "mech",
  4: "astronaut",
  5: "miner",
  6: "fighter",
  7: "rover",
  8: "command-center",
  9: "turret",
  10: "hangar",
  11: "factory",
  12: "site",
  13: "craft-site",
  14: "resource",
  15: "meteor",
  16: "building",
};

export function entityKindName(kind: number): string {
  return ENTITY_KIND_NAMES[kind] ?? `kind-${kind}`;
}

/**
 * Map a gameplay `kind` string onto its numeric id.
 *
 * Called on cold paths only — an entity is created or destroyed, not moved — so
 * the object lookup is not on any per-frame path. An unrecognised kind maps to
 * `Unknown` rather than throwing: a diagnostic must never be the thing that
 * breaks a spawn.
 */
const KIND_BY_NAME: Readonly<Record<string, number>> = {
  alien: EntityKind.AlienWalker,
  alienDrake: EntityKind.AlienDrake,
  strongAlienMech: EntityKind.AlienMech,
  walker: EntityKind.AlienWalker,
  drake: EntityKind.AlienDrake,
  mech: EntityKind.AlienMech,
  astronaut: EntityKind.Astronaut,
  miner: EntityKind.Miner,
  fighter: EntityKind.Fighter,
  rover: EntityKind.Rover,
  "command-center": EntityKind.CommandCenter,
  turret: EntityKind.Turret,
  hangar: EntityKind.Hangar,
  factory: EntityKind.Factory,
  aircraft_factory: EntityKind.Factory,
  site: EntityKind.ConstructionSite,
  "craft-site": EntityKind.CraftProductionSite,
  resource: EntityKind.ResourceNode,
  meteor: EntityKind.Meteor,
};

export function entityKindId(kind: string | null | undefined): number {
  if (!kind) return EntityKind.Unknown;
  return KIND_BY_NAME[kind] ?? EntityKind.Unknown;
}

// ---------------------------------------------------------------------------
// Alien lifecycle. The plan's Requested -> Created -> Waiting -> Active ->
// Killed -> Destroyed, as numbers so an illegal transition is a comparison.
// ---------------------------------------------------------------------------

export const Lifecycle = {
  None: 0,
  Requested: 1,
  Created: 2,
  Waiting: 3,
  Active: 4,
  Killed: 5,
  Destroyed: 6,
} as const;
export type LifecycleId = (typeof Lifecycle)[keyof typeof Lifecycle];

const LIFECYCLE_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "Requested",
  2: "Created",
  3: "Waiting",
  4: "Active",
  5: "Killed",
  6: "Destroyed",
};

export function lifecycleName(stage: number): string {
  return LIFECYCLE_NAMES[stage] ?? `stage-${stage}`;
}

/**
 * Is `next` a legal successor of `previous`?
 *
 * Forward-only, one step at a time, with two documented shortcuts:
 * `Active -> Destroyed` (a scenario reset disposes a live alien without a
 * death) and `Waiting -> Destroyed` (same, for a reserve). `Killed -> Destroyed`
 * is the ordinary death path. Anything else is an invalid lifecycle and
 * preserves a snapshot.
 */
export function isLegalLifecycleTransition(
  previous: number,
  next: number,
): boolean {
  switch (previous) {
    case Lifecycle.None:
      return next === Lifecycle.Requested;
    case Lifecycle.Requested:
      return next === Lifecycle.Created;
    case Lifecycle.Created:
      return next === Lifecycle.Waiting || next === Lifecycle.Destroyed;
    case Lifecycle.Waiting:
      return next === Lifecycle.Active || next === Lifecycle.Destroyed;
    case Lifecycle.Active:
      return next === Lifecycle.Killed || next === Lifecycle.Destroyed;
    case Lifecycle.Killed:
      return next === Lifecycle.Destroyed;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Interaction stages and terminal results
// ---------------------------------------------------------------------------

export const InteractionStage = {
  XrInput: 1,
  Raycast: 2,
  UiBoundary: 3,
  ButtonHandler: 4,
  GameplayValidation: 5,
  StateChange: 6,
  VisualResponse: 7,
  Terminal: 8,
} as const;

const STAGE_NAMES: Readonly<Record<number, string>> = {
  1: "xr-input",
  2: "raycast",
  3: "ui-boundary",
  4: "button-handler",
  5: "gameplay-validation",
  6: "state-change",
  7: "visual-response",
  8: "terminal",
};

export function interactionStageName(stage: number): string {
  return STAGE_NAMES[stage] ?? `stage-${stage}`;
}

export const Terminal = {
  Pending: 0,
  Success: 1,
  RayMiss: 2,
  ButtonMiss: 3,
  Blocked: 4,
  RejectedWithReason: 5,
  ActionFailure: 6,
  UiResponseFailure: 7,
  Timeout: 8,
} as const;
export type TerminalId = (typeof Terminal)[keyof typeof Terminal];

const TERMINAL_NAMES: Readonly<Record<number, string>> = {
  0: "pending",
  1: "success",
  2: "ray-miss",
  3: "button-miss",
  4: "blocked",
  5: "rejected-with-reason",
  6: "action-failure",
  7: "ui-response-failure",
  8: "timeout",
};

export function terminalName(result: number): string {
  return TERMINAL_NAMES[result] ?? `result-${result}`;
}

/** Which hand, when it can be observed. */
export const Handedness = {
  Unknown: 0,
  Left: 1,
  Right: 2,
  Gaze: 3,
  Screen: 4,
} as const;

const HAND_NAMES: Readonly<Record<number, string>> = {
  0: "unknown",
  1: "left",
  2: "right",
  3: "gaze",
  4: "screen",
};

export function handednessName(hand: number): string {
  return HAND_NAMES[hand] ?? `hand-${hand}`;
}

// ---------------------------------------------------------------------------
// Runtime signals and the `Other`-bucket classification
// ---------------------------------------------------------------------------

export const RuntimeSignal = {
  LongTask: 1,
  SessionStart: 2,
  SessionEnd: 3,
  VisibilityChange: 4,
  RefreshRateChange: 5,
  InputSourcesChange: 6,
  MemorySample: 7,
  ShaderCompile: 8,
  ShaderLink: 9,
  ProgramCountChange: 10,
  AllocationSample: 11,
  CallbackGap: 12,
  PredictedDisplaySkew: 13,
} as const;

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "long-task",
  2: "xr-session-start",
  3: "xr-session-end",
  4: "xr-visibility-change",
  5: "xr-refresh-rate-change",
  6: "xr-input-sources-change",
  7: "memory-sample",
  8: "shader-compile",
  9: "shader-link",
  10: "program-count-change",
  11: "allocation-sample",
  12: "callback-gap",
  13: "predicted-display-skew",
};

export function runtimeSignalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `signal-${signal}`;
}

/**
 * The `Other`-bucket verdict.
 *
 * **This is a classification of the evidence, never a cause.** A 2.5-second
 * callback gap with no long task next to it means "no browser-side cause was
 * observed", which is a real and useful finding — it points at the XR runtime,
 * the compositor or a native stall, none of which JavaScript can see — and it
 * is emphatically not proof that JavaScript was innocent.
 */
export const OtherEvidence = {
  None: 0,
  LongTaskObserved: 1,
  ShaderObserved: 2,
  MemoryObserved: 3,
  XrEventObserved: 4,
  MultipleSignals: 5,
  NoBrowserSideCause: 6,
} as const;

const EVIDENCE_NAMES: Readonly<Record<number, string>> = {
  0: "no-evidence-collected",
  1: "main-thread-long-task-observed",
  2: "shader-operation-observed",
  3: "memory-or-allocation-event-observed",
  4: "xr-session-or-visibility-event-observed",
  5: "multiple-signals-observed",
  6: "no-browser-side-cause-observed",
};

export function otherEvidenceName(evidence: number): string {
  return EVIDENCE_NAMES[evidence] ?? `evidence-${evidence}`;
}

// ---------------------------------------------------------------------------
// Contract ids
// ---------------------------------------------------------------------------

export const Contract = {
  TutorialGateBeforeWavePrep: 1,
  AlienCreatedBeforeWaiting: 2,
  AlienWaitingBeforeActive: 3,
  NoActivationInInvalidStage: 4,
  ActiveNeverAboveCap: 5,
  DamageReachesAlertConsumers: 6,
  MiningDepositReachesEconomy: 7,
  TabletOrderReachesBuilder: 8,
  ResetClearsAliens: 9,
  ResetClearsSelection: 10,
  ResetClearsConstruction: 11,
  ResetRepublishesStartingState: 12,
  ClickReachesTerminalResult: 13,
  WaitingAlienDetached: 14,
} as const;
export type ContractId = (typeof Contract)[keyof typeof Contract];

const CONTRACT_NAMES: Readonly<Record<number, string>> = {
  1: "tutorial-gate-before-wave-prep",
  2: "alien-created-before-waiting",
  3: "alien-waiting-before-active",
  4: "no-activation-in-invalid-stage",
  5: "active-never-above-cap",
  6: "damage-reaches-alert-consumers",
  7: "mining-deposit-reaches-economy",
  8: "tablet-order-reaches-builder",
  9: "reset-clears-aliens",
  10: "reset-clears-selection",
  11: "reset-clears-construction",
  12: "reset-republishes-starting-state",
  13: "click-reaches-terminal-result",
  14: "waiting-alien-detached",
};

export function contractName(contract: number): string {
  return CONTRACT_NAMES[contract] ?? `contract-${contract}`;
}

/** When a contract's reader is allowed to see the writer's value. */
export const ContractTiming = {
  Initialization: 1,
  BeforeSystem: 2,
  SameFrame: 3,
  NextFrame: 4,
  Eventual: 5,
} as const;
export type ContractTimingId =
  (typeof ContractTiming)[keyof typeof ContractTiming];

const TIMING_NAMES: Readonly<Record<number, string>> = {
  1: "initialization",
  2: "before-system",
  3: "same-frame",
  4: "next-frame",
  5: "eventual",
};

export function contractTimingName(timing: number): string {
  return TIMING_NAMES[timing] ?? `timing-${timing}`;
}

// ---------------------------------------------------------------------------
// State ids — the named pieces of shared state a contract can be written about
// ---------------------------------------------------------------------------

export const State = {
  None: 0,
  WaveNumber: 1,
  WaveStage: 2,
  WaveTimer: 3,
  SpawnedWaveNumber: 4,
  ReleasedAlienCount: 5,
  ReleaseTimer: 6,
  ActiveAliens: 7,
  WaitingAliens: 8,
  AlienCap: 9,
  WaitingReady: 10,
  RequestedRelease: 11,
  ActualRelease: 12,
  PreparedReserve: 13,
  PreparationProgress: 14,
  PreparationLimit: 15,
  RequiredAlienTotal: 16,
  HighWaterActive: 17,

  TutorialGoverning: 30,
  TutorialHoldsCountdown: 31,
  TutorialReleaseBudget: 32,
  TutorialDrill: 33,

  Crystals: 50,
  CrystalsMined: 51,
  MinerCargo: 52,
  NodeRemaining: 53,

  Health: 70,
  MatchStatus: 71,
  EnemiesKilled: 72,
  CommandCenterAlive: 73,

  AlertActive: 90,
  AlertPriority: 91,
  ThreatBadge: 92,

  TabletView: 110,
  SelectedBuildingKind: 111,
  SelectedCraftKind: 112,
  BuildPlacementActive: 113,
  SiteBuilderCount: 114,
  SiteProgress: 115,
  QueueOrder: 116,

  SceneEntities: 130,
  SceneGeometries: 131,
  ScenePrograms: 132,
  SceneTextures: 133,
  SceneMaterials: 134,
} as const;
export type StateId = (typeof State)[keyof typeof State];

const STATE_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "waveNumber",
  2: "waveStage",
  3: "waveTimer",
  4: "spawnedWaveNumber",
  5: "releasedAlienCount",
  6: "releaseTimer",
  7: "activeAliens",
  8: "waitingAliens",
  9: "alienCap",
  10: "waitingReady",
  11: "requestedRelease",
  12: "actualRelease",
  13: "preparedReserve",
  14: "preparationProgress",
  15: "preparationLimit",
  16: "requiredAlienTotal",
  17: "highestActiveObserved",
  30: "tutorialGoverning",
  31: "tutorialHoldsCountdown",
  32: "tutorialReleaseBudget",
  33: "tutorialDrill",
  50: "crystals",
  51: "crystalsMined",
  52: "minerCargo",
  53: "nodeRemaining",
  70: "health",
  71: "matchStatus",
  72: "enemiesKilled",
  73: "commandCenterAlive",
  90: "alertActive",
  91: "alertPriority",
  92: "threatBadge",
  110: "tabletView",
  111: "selectedBuildingKind",
  112: "selectedCraftKind",
  113: "buildPlacementActive",
  114: "siteBuilderCount",
  115: "siteProgress",
  116: "queueOrder",
  130: "sceneEntities",
  131: "sceneGeometries",
  132: "scenePrograms",
  133: "sceneTextures",
  134: "sceneMaterials",
};

export function stateName(state: number): string {
  return STATE_NAMES[state] ?? `state-${state}`;
}

/** `WaveStage` as a number, so it can ride in a `Uint8Array`. */
export function waveStageId(stage: string): number {
  switch (stage) {
    case "countdown":
      return 1;
    case "active":
      return 2;
    case "stopped":
      return 3;
    default:
      return 0;
  }
}

/** `MatchStatus` as a number. */
export function matchStatusId(status: string): number {
  switch (status) {
    case "playing":
      return 1;
    case "victory":
      return 2;
    case "defeat":
      return 3;
    case "restarting":
      return 4;
    case "awaiting-start":
      return 5;
    default:
      return 0;
  }
}
