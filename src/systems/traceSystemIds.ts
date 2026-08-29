/**
 * Stable numeric identity for every system, and the map from that identity to
 * the position the system actually runs at in this build.
 *
 * ## Why an explicit table instead of "index in getSystems()"
 *
 * The registration index is exactly the thing that moves. Insert one system
 * near the top of `index.ts` and every index below it shifts by one — which
 * would silently re-point every id in a console capture taken yesterday at a
 * different system today. So the two are kept apart:
 *
 * - **`systemId`** is assigned by name, here, by hand, and never reused. It is
 *   what a trace event stores and what a saved capture is read against.
 * - **`registrationIndex`** is the live position in `world.getSystems()`. It is
 *   recorded alongside the id, in the startup map and on every event, so a
 *   reader can see the order this particular build ran in.
 *
 * A system missing from the table still works: it gets a deterministic id in a
 * reserved fallback band derived from its name, and the startup map prints a
 * warning naming it, so the omission announces itself instead of quietly
 * producing an id that could collide later.
 */

import { TraceKind } from "./traceIds.js";
import {
  diagnosticHeader,
  executionOrderLine,
  isTraceRecording,
  recordEvent,
  setTraceSystemContext,
} from "./traceRecorder.js";
import { EXECUTION_RING_SLOTS, TRACE_PREFIX } from "./traceFlags.js";

/**
 * The stable id table.
 *
 * 1-99 IWSDK systems, 100-199 RTSVR systems, 200-254 the fallback band for a
 * system nobody added here yet. 0 means "no system" (a record emitted outside
 * any system's update, such as a UIKit click handler or an XR event listener).
 *
 * **Never renumber an entry and never reuse a retired one.** A capture from a
 * previous build is read against this table.
 */
const STABLE_IDS: Readonly<Record<string, number>> = {
  // --- IWSDK -------------------------------------------------------------
  InputSystem: 1,
  PanelUISystem: 2,
  ScreenSpaceUISystem: 3,
  CanvasPointerSystem: 4,
  GrabSystem: 5,
  TransformSystem: 6,
  VisibilitySystem: 7,
  EnvironmentSystem: 8,
  LevelSystem: 9,
  AudioSystem: 10,
  FollowSystem: 11,
  LocomotionSystem: 12,
  PhysicsSystem: 13,
  SceneUnderstandingSystem: 14,
  EnvironmentRaycastSystem: 15,
  CameraSystem: 16,
  XRLayerSystem: 17,
  DepthSensingSystem: 18,

  // --- RTSVR -------------------------------------------------------------
  BoardSystem: 100,
  SkySystem: 101,
  StructuresSystem: 102,
  PerformanceSystem: 103,
  TabletSystem: 104,
  InteractionSystem: 105,
  MovementSystem: 106,
  WaveSystem: 107,
  CombatSystem: 108,
  CombatEffectsSystem: 109,
  UnderAttackAlertSystem: 110,
  UnderAttackVfxSystem: 111,
  UnderAttackBannerSystem: 112,
  UnderAttackAudioSystem: 113,
  // Appended at the end of the range rather than slotted next to the other
  // audio systems: these ids are written into trace events, so renumbering an
  // existing one would make every previously captured log decode wrong.
  SfxSystem: 131,
  CommandCenterHudSystem: 114,
  TutorialSystem: 115,
  AlienAnimationSystem: 116,
  CommandCenterAnimationSystem: 117,
  TurretAnimationSystem: 118,
  UnitAnimationSystem: 119,
  MiningSystem: 120,
  MinerAnimationSystem: 121,
  ConstructionSystem: 122,
  CraftProductionSystem: 123,
  CraftVisualRiseSystem: 124,
  MeteorSystem: 125,
  MatchResultSystem: 126,
  ScenarioResetSystem: 127,
  GpuWarmupSystem: 128,
  ProgramChurnSystem: 129,
  TraceDiagnosticsSystem: 130,
};

/** Lowest and highest id handed out to a system not in {@link STABLE_IDS}. */
const FALLBACK_FIRST = 200;
const FALLBACK_LAST = 254;

/**
 * Callers outside any system — a UIKit click handler, an XR event listener, a
 * `PerformanceObserver` callback. Deliberately id 0 so it reads as "no owner"
 * rather than being attributed to whichever system happened to run last.
 */
export const NO_SYSTEM_ID = 0;

interface SystemIdentity {
  id: number;
  name: string;
  registrationIndex: number;
}

const identityByName = new Map<string, SystemIdentity>();
const identityById = new Map<number, SystemIdentity>();
/** Registration index -> identity, for the execution ring's slot lookup. */
const identityBySlot: (SystemIdentity | undefined)[] = [];
const collisions: string[] = [];
const unlisted: string[] = [];

/** FNV-1a, folded into the fallback band. Deterministic for a given name. */
function fallbackId(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const span = FALLBACK_LAST - FALLBACK_FIRST + 1;
  return FALLBACK_FIRST + (hash % span);
}

/**
 * Assign ids and registration indices for the world's live system array.
 *
 * Called once, from `installFrameProfiler`, with `world.getSystems()` — which
 * is already sorted into execution order by `elics`, so the array position IS
 * the execution position.
 */
export function registerSystemIdentities(names: readonly string[]): void {
  identityByName.clear();
  identityById.clear();
  identityBySlot.length = 0;
  collisions.length = 0;
  unlisted.length = 0;

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    let id = STABLE_IDS[name];
    if (id === undefined) {
      unlisted.push(name);
      id = fallbackId(name);
    }
    // Walk forward out of a collision rather than overwrite. The first claim
    // wins, which keeps the explicit table authoritative, and the collision is
    // reported so the table gets the missing entry instead of the trace
    // quietly attributing two systems to one id.
    if (identityById.has(id)) {
      const original = identityById.get(id)!.name;
      let candidate = id;
      for (let step = 0; step < FALLBACK_LAST - FALLBACK_FIRST + 1; step += 1) {
        candidate = FALLBACK_FIRST + ((candidate - FALLBACK_FIRST + 1) % (FALLBACK_LAST - FALLBACK_FIRST + 1));
        if (!identityById.has(candidate)) break;
      }
      collisions.push(`${name} wanted ${id} (held by ${original}) -> ${candidate}`);
      id = candidate;
    }
    const identity: SystemIdentity = { id, name, registrationIndex: index };
    identityByName.set(name, identity);
    identityById.set(id, identity);
    identityBySlot[index] = identity;
  }
}

/** The stable id for a system name, or {@link NO_SYSTEM_ID}. */
export function systemIdFor(name: string): number {
  return identityByName.get(name)?.id ?? NO_SYSTEM_ID;
}

/** The live execution position for a system name, or -1. */
export function registrationIndexFor(name: string): number {
  return identityByName.get(name)?.registrationIndex ?? -1;
}

/** Name for a stable id, for export-time formatting. */
export function systemNameFor(id: number): string {
  if (id === NO_SYSTEM_ID) return "-";
  return identityById.get(id)?.name ?? `sys-${id}`;
}

/** Short name for an execution-ring slot. */
export function slotName(slot: number): string {
  const identity = identityBySlot[slot];
  if (!identity) return `slot${slot}`;
  return identity.name.replace(/System$/, "");
}

/** Ids that were not in the explicit table, so the omission can be reported. */
export function unlistedSystemNames(): readonly string[] {
  return unlisted;
}

/** Collisions resolved into the fallback band. Empty in a healthy build. */
export function systemIdCollisions(): readonly string[] {
  return collisions;
}

/** How many systems exceeded the execution ring's slot count, if any. */
export function slotOverflowCount(): number {
  return Math.max(0, identityBySlot.length - EXECUTION_RING_SLOTS);
}

/**
 * Print the id / name / registration-index map once, and record it as a single
 * event so a dump taken later still contains it.
 *
 * This is also the **initialization snapshot** the Phase 0 audit calls for:
 * `System.init()` runs inside `World.registerSystem`, before any diagnostic can
 * be installed, so the trace cannot observe initialization as it happens. What
 * it can do is state, at the first moment it is able to see anything, exactly
 * which systems exist and in what order — and say plainly that the init calls
 * themselves were not observed.
 */
export function reportSystemMap(): void {
  const rows: string[] = [];
  for (const identity of identityBySlot) {
    if (!identity) continue;
    rows.push(`${identity.registrationIndex}:${identity.id}:${identity.name}`);
  }
  const warnings: string[] = [];
  if (unlisted.length > 0) {
    warnings.push(`unlisted (fallback id): ${unlisted.join(", ")}`);
  }
  if (collisions.length > 0) {
    warnings.push(`id collisions: ${collisions.join("; ")}`);
  }
  const overflow = slotOverflowCount();
  if (overflow > 0) {
    warnings.push(
      `${overflow} systems past EXECUTION_RING_SLOTS=${EXECUTION_RING_SLOTS}; ` +
        `their execution status is not recorded`,
    );
  }
  console.log(
    `${TRACE_PREFIX} ${diagnosticHeader("SystemMap")} | ` +
      `systems ${rows.length} | init() ran before diagnostics were installed ` +
      `and was NOT observed\n  ${rows.join("\n  ")}` +
      (warnings.length > 0 ? `\n  WARN ${warnings.join("\n  WARN ")}` : ""),
  );
  if (isTraceRecording()) {
    setTraceSystemContext(NO_SYSTEM_ID, 0);
    recordEvent(
      TraceKind.SystemMap,
      0,
      0,
      0,
      rows.length,
      0,
      0,
      0,
      performance.now(),
    );
  }
}

/** The order systems actually ran in on a recent frame. Used by dumps. */
export function recentExecutionOrder(rowsBack = 1): string {
  return executionOrderLine(rowsBack, slotName);
}
