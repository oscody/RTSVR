import {
  AdditiveBlending,
  type Entity,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type World,
  createSystem,
} from "@iwsdk/core";
import {
  GAMEPLAY_VFX_BODY_Y,
  GAMEPLAY_VFX_BUILDING_DEATH_SCALE,
  GAMEPLAY_VFX_COMPLETION_COLOR,
  GAMEPLAY_VFX_COMPLETION_SECONDS,
  GAMEPLAY_VFX_DEATH_ALIEN_COLOR,
  GAMEPLAY_VFX_DEATH_BUILDING_COLOR,
  GAMEPLAY_VFX_DEATH_SECONDS,
  GAMEPLAY_VFX_DEATH_UNIT_COLOR,
  GAMEPLAY_VFX_DEPOSIT_COLOR,
  GAMEPLAY_VFX_DEPOSIT_SECONDS,
  GAMEPLAY_VFX_FLASH_POOL_SIZE,
  GAMEPLAY_VFX_FLASH_RADIUS,
  GAMEPLAY_VFX_MINING_COLOR,
  GAMEPLAY_VFX_MINING_SECONDS,
  GAMEPLAY_VFX_PULSE_INNER_RADIUS,
  GAMEPLAY_VFX_PULSE_OUTER_RADIUS,
  GAMEPLAY_VFX_PULSE_POOL_SIZE,
} from "./constants.ts";
import { warmObjectForRender } from "./gpuWarmup.js";
import { tracked } from "./resourceLifetime.js";
import { boardState } from "./state.js";
import { makeNonInteractive } from "./sharedGeometry.js";

/**
 * Short visual punctuation for economy, death and completion events.
 *
 * Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-04-Mining-Death-Completion-VFX-Plan.md`.
 *
 * ## Why this is not in `combatEffects.ts`
 *
 * That file owns weapon fire and is already the most timing-sensitive visual
 * path in the game. These events — a deposit landing, a building finishing, a
 * unit dying — share the *pooling* pattern but nothing else: different
 * triggers, different owners, different lifetimes. Folding them in would make
 * one file the place every visual effect goes, which is how the combat path
 * acquires risk it did not need.
 *
 * ## Presentation only
 *
 * Nothing here may delay damage, crystal credit, construction completion,
 * entity teardown, or a victory/defeat check. Every emitter is called *after*
 * the rule has already resolved, and reads state that is about to be thrown
 * away — a death effect samples the target's position while its `Object3D`
 * still exists, then the entity is released as it always was.
 *
 * ## Lifetime
 *
 * The pool is built lazily under `boardState.boardRoot` and carries **no**
 * `ScenarioObject` component, so a scenario reset never disposes it —
 * {@link clearGameplayEffects} parks every slot instead. Same rule, and the
 * same reason, as `combatEffects.ts` and `underAttackVfx.ts`.
 *
 * A full pool **drops** the extra visual. Allocating a mesh during the frame
 * where six aliens died at once is exactly the wrong moment to allocate.
 */

/** What an effect means, which is carried by colour rather than text. */
export type GameplayEffectKind =
  | "mining"
  | "deposit"
  | "death-alien"
  | "death-unit"
  | "death-building"
  | "completion";

interface FlashSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  active: boolean;
  age: number;
  life: number;
  baseScale: number;
}

interface PulseSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  active: boolean;
  age: number;
  life: number;
  baseScale: number;
}

const flashSlots: FlashSlot[] = [];
const pulseSlots: PulseSlot[] = [];
let pooledRoot: Object3D | null = null;
let effectsWorld: World | null = null;

// Scratch, reused across events. Allocating a Vector3 per death would put a
// GC pause exactly where the frame is already busiest.
const tmpWorld = new Vector3();

/** Colour and lifetime for each kind, so emitters carry no magic numbers. */
const EFFECT_STYLE: Readonly<
  Record<GameplayEffectKind, { color: number; life: number; scale: number }>
> = {
  mining: { color: GAMEPLAY_VFX_MINING_COLOR, life: GAMEPLAY_VFX_MINING_SECONDS, scale: 0.7 },
  deposit: { color: GAMEPLAY_VFX_DEPOSIT_COLOR, life: GAMEPLAY_VFX_DEPOSIT_SECONDS, scale: 1 },
  "death-alien": { color: GAMEPLAY_VFX_DEATH_ALIEN_COLOR, life: GAMEPLAY_VFX_DEATH_SECONDS, scale: 1 },
  "death-unit": { color: GAMEPLAY_VFX_DEATH_UNIT_COLOR, life: GAMEPLAY_VFX_DEATH_SECONDS, scale: 1 },
  "death-building": {
    color: GAMEPLAY_VFX_DEATH_BUILDING_COLOR,
    life: GAMEPLAY_VFX_DEATH_SECONDS,
    scale: GAMEPLAY_VFX_BUILDING_DEATH_SCALE,
  },
  completion: { color: GAMEPLAY_VFX_COMPLETION_COLOR, life: GAMEPLAY_VFX_COMPLETION_SECONDS, scale: 1 },
};

/**
 * Build the pool under the current board root, or rebuild it if the root changed.
 *
 * Returns false when there is no board yet, which is the normal answer during
 * boot and teardown — an emitter that fires then simply produces nothing.
 */
function ensurePool(): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !effectsWorld) return false;
  if (pooledRoot === rootObject && flashSlots.length > 0) return true;

  flashSlots.length = 0;
  pulseSlots.length = 0;

  // One geometry shared by every flash; per-slot materials because each fades
  // its own opacity and carries its own colour.
  const flashGeometry = tracked(
    new SphereGeometry(GAMEPLAY_VFX_FLASH_RADIUS, 8, 8),
    "geometry",
    "pool",
    "gameplay-flash",
  );
  for (let index = 0; index < GAMEPLAY_VFX_FLASH_POOL_SIZE; index += 1) {
    const material = tracked(
      new MeshBasicMaterial({
        color: GAMEPLAY_VFX_MINING_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      }),
      "material",
      "pool",
      "gameplay-flash",
      `slot:${index}`,
    );
    const mesh = new Mesh(flashGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `GameplayFlash_${index}`;
    mesh.userData.drawCat = "vfx";
    mesh.visible = false;
    mesh.frustumCulled = false;
    effectsWorld.createTransformEntity(mesh, { parent: root });
    flashSlots.push({ mesh, material, active: false, age: 0, life: 0, baseScale: 1 });
  }

  // A flat ring, laid down on the board. Additive so it reads over the dark
  // Martian ground without hiding what is beneath it.
  const pulseGeometry = tracked(
    new RingGeometry(GAMEPLAY_VFX_PULSE_INNER_RADIUS, GAMEPLAY_VFX_PULSE_OUTER_RADIUS, 24),
    "geometry",
    "pool",
    "gameplay-pulse",
  );
  for (let index = 0; index < GAMEPLAY_VFX_PULSE_POOL_SIZE; index += 1) {
    const material = tracked(
      new MeshBasicMaterial({
        color: GAMEPLAY_VFX_COMPLETION_COLOR,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      "material",
      "pool",
      "gameplay-pulse",
      `slot:${index}`,
    );
    const mesh = new Mesh(pulseGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `GameplayPulse_${index}`;
    mesh.userData.drawCat = "vfx";
    mesh.rotateX(-Math.PI / 2); // lie flat on the board
    mesh.visible = false;
    mesh.frustumCulled = false;
    effectsWorld.createTransformEntity(mesh, { parent: root });
    pulseSlots.push({ mesh, material, active: false, age: 0, life: 0, baseScale: 1 });
  }

  // Compile both variants before the first event, or the first deposit of a
  // session pays for a shader compile mid-frame.
  warmObjectForRender(flashSlots[0]?.mesh, "gameplay-flash-pool");
  warmObjectForRender(pulseSlots[0]?.mesh, "gameplay-pulse-pool");

  pooledRoot = rootObject;
  return true;
}

/** Convert a world point into board-root local space, where the pool lives. */
function toRootLocal(worldPoint: Vector3): void {
  const rootObject = boardState.boardRoot?.object3D;
  if (rootObject) rootObject.worldToLocal(worldPoint);
}

function spawnFlash(x: number, y: number, z: number, color: number, life: number, scale: number): void {
  for (const slot of flashSlots) {
    if (slot.active) continue;
    slot.active = true;
    slot.age = 0;
    slot.life = life;
    slot.baseScale = scale;
    slot.material.color.setHex(color);
    slot.material.opacity = 1;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.setScalar(scale);
    slot.mesh.visible = true;
    return;
  }
  // Pool full: drop it. See the module comment — never allocate here.
}

function spawnPulse(x: number, y: number, z: number, color: number, life: number, scale: number): void {
  for (const slot of pulseSlots) {
    if (slot.active) continue;
    slot.active = true;
    slot.age = 0;
    slot.life = life;
    slot.baseScale = scale;
    slot.material.color.setHex(color);
    slot.material.opacity = 0.9;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.setScalar(scale * 0.4);
    slot.mesh.visible = true;
    return;
  }
}

/**
 * Emit one effect at an entity's position.
 *
 * Reads `entity.object3D` immediately, which is why every caller must invoke
 * this **before** the entity is released — a death effect for an entity whose
 * subtree is already gone has nowhere to appear.
 */
function emitAt(entity: Entity | null, kind: GameplayEffectKind, withPulse: boolean): void {
  if (!entity?.object3D || !ensurePool()) return;
  const style = EFFECT_STYLE[kind];
  entity.object3D.getWorldPosition(tmpWorld);
  toRootLocal(tmpWorld);
  spawnFlash(
    tmpWorld.x,
    tmpWorld.y + GAMEPLAY_VFX_BODY_Y,
    tmpWorld.z,
    style.color,
    style.life,
    style.scale,
  );
  if (withPulse) {
    // Slightly above the ground so the ring does not z-fight the terrain.
    spawnPulse(tmpWorld.x, tmpWorld.y + 0.004, tmpWorld.z, style.color, style.life, style.scale);
  }
}

/**
 * A miner has just loaded cargo at a node.
 *
 * Fires on the `0 -> positive` cargo transition, never per mining frame — the
 * caller passes the transition, not the miner's stage, because a miner sits in
 * one stage across many frames.
 */
export function emitMiningLoadedVfx(node: Entity | null): void {
  emitAt(node, "mining", false);
}

/** A positive deposit has been credited to the command centre. */
export function emitDepositVfx(commandCenter: Entity | null): void {
  emitAt(commandCenter, "deposit", true);
}

/**
 * A real combat kill, emitted before the target is released.
 *
 * **Only from the combat kill path.** Putting this in `releaseEntity` would
 * make scenario resets, cancelled construction sites, replaced sites and
 * discarded reserve aliens all look like deaths.
 */
export function emitDeathVfx(
  target: Entity | null,
  kind: "alien" | "friendly-unit" | "friendly-building",
): void {
  emitAt(
    target,
    kind === "alien" ? "death-alien" : kind === "friendly-unit" ? "death-unit" : "death-building",
    true,
  );
}

/** A building or craft has finished and the real entity now exists. */
export function emitCompletionVfx(entity: Entity | null): void {
  emitAt(entity, "completion", true);
}

/**
 * Park every active effect. Called by the scenario reset.
 *
 * Parks rather than disposes: the pool has no `ScenarioObject`, survives the
 * reset, and is reused by the next match.
 */
export function clearGameplayEffects(): void {
  for (const slot of flashSlots) {
    slot.active = false;
    slot.mesh.visible = false;
    slot.material.opacity = 0;
  }
  for (const slot of pulseSlots) {
    slot.active = false;
    slot.mesh.visible = false;
    slot.material.opacity = 0;
  }
}

/** Diagnostic surface: how many slots are live right now. */
export function gameplayEffectsActive(): { flashes: number; pulses: number } {
  let flashes = 0;
  let pulses = 0;
  for (const slot of flashSlots) if (slot.active) flashes += 1;
  for (const slot of pulseSlots) if (slot.active) pulses += 1;
  return { flashes, pulses };
}

export class GameplayEffectsSystem extends createSystem({}) {
  init(): void {
    effectsWorld = this.world;
  }

  update(delta: number): void {
    // Build the pool as soon as there is a board to hang it on, which is
    // during the loading screen — NOT on the frame of the first event.
    //
    // Lazily building it from the first emitter looked equivalent and was not:
    // `warmObjectForRender` only QUEUES a compile, and `GpuWarmupSystem`
    // processes one queue entry per frame. So a pool built by the first
    // deposit had its flash drawn in that same frame, one to two frames ahead
    // of its own warm-up — the shader compiled mid-gameplay and the warm-up
    // that exists to prevent exactly that arrived too late to matter.
    //
    // Cheap to call every frame: it returns on an identity check once built.
    if (!ensurePool()) return;
    const frameDelta = Math.max(0, delta);

    for (const slot of flashSlots) {
      if (!slot.active) continue;
      slot.age += frameDelta;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      slot.material.opacity = 1 - t;
      slot.mesh.scale.setScalar(slot.baseScale * (1 + t * 1.5));
    }

    for (const slot of pulseSlots) {
      if (!slot.active) continue;
      slot.age += frameDelta;
      const t = slot.age / slot.life;
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      // A ring expands faster than the flash and fades on a curve, so it reads
      // as a shockwave rather than a second sphere.
      slot.material.opacity = 0.9 * (1 - t) * (1 - t);
      slot.mesh.scale.setScalar(slot.baseScale * (0.4 + t * 1.6));
    }
  }
}
