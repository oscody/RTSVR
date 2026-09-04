import {
  type Material,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  createSystem,
  type Entity,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  ALIEN_DRAKE_VISUAL_ELEVATION,
  COMBAT_VFX_ALIEN_BURST_COLOR,
  COMBAT_VFX_ASTRONAUT_BOLT_COLOR,
  COMBAT_VFX_ASTRONAUT_MUZZLE_COLOR,
  COMBAT_VFX_BOLT_ARRIVAL_EPSILON,
  COMBAT_VFX_BOLT_COLOR,
  COMBAT_VFX_BOLT_POOL_SIZE,
  COMBAT_VFX_BOLT_RADIUS,
  COMBAT_VFX_BOLT_SPEED,
  COMBAT_VFX_DOUBLE_SPACING,
  COMBAT_VFX_DRAKE_BURST_COLOR,
  COMBAT_VFX_FLASH_POOL_SIZE,
  COMBAT_VFX_FLASH_RADIUS,
  COMBAT_VFX_IMPACT_COLOR,
  COMBAT_VFX_IMPACT_FLASH_SECONDS,
  COMBAT_VFX_LASER_LENGTH,
  COMBAT_VFX_LASER_SPEED,
  COMBAT_VFX_LASER_THICKNESS,
  COMBAT_VFX_MECH_BURST_COLOR,
  COMBAT_VFX_MELEE_BURST_SECONDS,
  COMBAT_VFX_MELEE_STRIKE_SECONDS,
  COMBAT_VFX_MUZZLE_COLOR,
  COMBAT_VFX_MUZZLE_FLASH_SECONDS,
  COMBAT_VFX_MUZZLE_FORWARD,
  COMBAT_VFX_MUZZLE_UP,
  COMBAT_VFX_TARGET_BODY_Y,
  COMBAT_VFX_TURRET_BOLT_COLOR,
  COMBAT_VFX_TURRET_MUZZLE_COLOR,
  RACER_CANNON_MUZZLE_NODES,
} from "./constants.ts";
import { gpuWarmupStatus, warmObjectForRender } from "./gpuWarmup.js";
import { trackResource } from "./resourceLifetime.js";
import { Building, Enemy, Unit, boardState } from "./state.js";
import { makeNonInteractive } from "./sharedGeometry.js";

type BoltShape = "plasma" | "laser";
type EmitterMode = "nodes" | "single" | "double" | "melee";

interface ShotProfile {
  boltColor: number;
  muzzleColor: number;
  impactColor: number;
  shape: BoltShape;
  speed: number;
  emitter: EmitterMode;
}

// Friendly ranged shots + alien melee bursts. Racer = round blue plasma from
// its two cannon nodes; AstronautA = one thin green laser; turret = twin
// orange lasers. Aliens use "melee": a strike flash on the attacker + an impact
// burst on the target, colored per kind (no traveling bolt).
const SHOT_PROFILES: Record<string, ShotProfile> = {
  racer: {
    boltColor: COMBAT_VFX_BOLT_COLOR,
    muzzleColor: COMBAT_VFX_MUZZLE_COLOR,
    impactColor: COMBAT_VFX_IMPACT_COLOR,
    shape: "plasma",
    speed: COMBAT_VFX_BOLT_SPEED,
    emitter: "nodes",
  },
  astronaut: {
    boltColor: COMBAT_VFX_ASTRONAUT_BOLT_COLOR,
    muzzleColor: COMBAT_VFX_ASTRONAUT_MUZZLE_COLOR,
    impactColor: COMBAT_VFX_ASTRONAUT_BOLT_COLOR,
    shape: "laser",
    speed: COMBAT_VFX_LASER_SPEED,
    emitter: "single",
  },
  turret: {
    boltColor: COMBAT_VFX_TURRET_BOLT_COLOR,
    muzzleColor: COMBAT_VFX_TURRET_MUZZLE_COLOR,
    impactColor: COMBAT_VFX_TURRET_BOLT_COLOR,
    shape: "laser",
    speed: COMBAT_VFX_LASER_SPEED,
    emitter: "double",
  },
  alien: {
    boltColor: COMBAT_VFX_ALIEN_BURST_COLOR,
    muzzleColor: COMBAT_VFX_ALIEN_BURST_COLOR,
    impactColor: COMBAT_VFX_ALIEN_BURST_COLOR,
    shape: "plasma",
    speed: 0,
    emitter: "melee",
  },
  alienDrake: {
    boltColor: COMBAT_VFX_DRAKE_BURST_COLOR,
    muzzleColor: COMBAT_VFX_DRAKE_BURST_COLOR,
    impactColor: COMBAT_VFX_DRAKE_BURST_COLOR,
    shape: "plasma",
    speed: 0,
    emitter: "melee",
  },
  strongAlienMech: {
    boltColor: COMBAT_VFX_MECH_BURST_COLOR,
    muzzleColor: COMBAT_VFX_MECH_BURST_COLOR,
    impactColor: COMBAT_VFX_MECH_BURST_COLOR,
    shape: "plasma",
    speed: 0,
    emitter: "melee",
  },
};

interface BoltSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  active: boolean;
  toX: number;
  toY: number;
  toZ: number;
  speed: number;
  impactColor: number;
}

interface FlashSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  active: boolean;
  age: number;
  life: number;
  baseScale: number;
}

// Module-level pool: built once under the (persistent) board root, reused for
// the whole match. Meshes are plain transform entities WITHOUT ScenarioObject
// so scenario reset never disposes them — clearCombatEffects() just parks them.
const boltSlots: BoltSlot[] = [];
const flashSlots: FlashSlot[] = [];
let pooledRoot: Object3D | null = null;
let effectsWorld: World | null = null;
let combatWarmupQueued = false;
/**
 * The warm-up meshes, held only until the real pool exists.
 *
 * These duplicate the pool's geometry and material so the shader compiles
 * before the first shot — the pool itself cannot be used, because it is built
 * lazily by `ensurePool()` on that very first shot, which is exactly too late.
 *
 * They used to be dropped on the floor here and leaked for the whole session:
 * the 2026-09-03 Quest capture reported `temporaryOutstanding=4` after every
 * teardown, the same four ids each time.
 *
 * **They cannot simply be disposed after warming.** Three.js refcounts
 * programs (`releaseProgram` destroys at `usedTimes === 0`), so releasing the
 * only material holding the compiled program destroys it, and the real pool
 * would recompile — undoing the warm-up entirely. They are therefore released
 * at the one safe moment: once the pool has acquired the same program and the
 * refcount is 2.
 */
let warmupMeshes: Mesh[] = [];
let warmupReleased = false;

// Scratch — reused across emit/update, never allocated per frame.
const tmpMuzzle = new Vector3();
const tmpTarget = new Vector3();
const tmpDir = new Vector3();
const tmpPerp = new Vector3();
const Z_AXIS = new Vector3(0, 0, 1);

function ensurePool(): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !effectsWorld) return false;
  if (pooledRoot === rootObject && boltSlots.length > 0) return true;

  // Board root changed (or first build) — (re)build the pool under it.
  boltSlots.length = 0;
  flashSlots.length = 0;

  // Unit sphere; each bolt scales it (uniform for plasma, stretched for laser).
  const boltGeometry = new SphereGeometry(1, 8, 8);
  // One geometry shared by every bolt in the pool, so it is registered once.
  // `pool` scope: this legitimately survives a reset and must PLATEAU, not
  // reach zero. Growth across identical cycles is the warning.
  trackResource(boltGeometry, {
    kind: "geometry",
    scope: "pool",
    label: "combat-bolt",
  });
  for (let index = 0; index < COMBAT_VFX_BOLT_POOL_SIZE; index += 1) {
    // Solid + toneMapped:false so the hue renders true. Additive blending over
    // the bright board washed every bolt to white, so bolts are NOT additive.
    const material = new MeshBasicMaterial({
      color: COMBAT_VFX_BOLT_COLOR,
      toneMapped: false,
    });
    // Per slot, not shared: each bolt animates its own opacity.
    trackResource(material, {
      kind: "material",
      scope: "pool",
      label: "combat-bolt",
      owner: `slot:${index}`,
    });
    const mesh = new Mesh(boltGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `CombatBolt_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.drawCat = "vfx"; // draw-call profiler category
    effectsWorld.createTransformEntity(mesh, { parent: root });
    boltSlots.push({
      mesh,
      material,
      active: false,
      toX: 0,
      toY: 0,
      toZ: 0,
      speed: COMBAT_VFX_BOLT_SPEED,
      impactColor: COMBAT_VFX_IMPACT_COLOR,
    });
  }

  const flashGeometry = new SphereGeometry(COMBAT_VFX_FLASH_RADIUS, 8, 8);
  trackResource(flashGeometry, {
    kind: "geometry",
    scope: "pool",
    label: "combat-flash",
  });
  for (let index = 0; index < COMBAT_VFX_FLASH_POOL_SIZE; index += 1) {
    // Normal blending (not additive) so colored bursts keep their hue over the
    // bright board; transparent for the opacity fade. toneMapped:false = vivid.
    const material = new MeshBasicMaterial({
      color: COMBAT_VFX_MUZZLE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    trackResource(material, {
      kind: "material",
      scope: "pool",
      label: "combat-flash",
      owner: `slot:${index}`,
    });
    const mesh = new Mesh(flashGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `CombatFlash_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.drawCat = "vfx"; // draw-call profiler category
    effectsWorld.createTransformEntity(mesh, { parent: root });
    flashSlots.push({
      mesh,
      material,
      active: false,
      age: 0,
      life: COMBAT_VFX_MUZZLE_FLASH_SECONDS,
      baseScale: 1,
    });
  }

  // Hand the program to the pool BEFORE the duplicates are released.
  //
  // This is the correction to a fix that was wrong on 2026-09-04. Three.js does
  // not acquire a program when a material is constructed — `getProgram` is
  // reached only from `prepareMaterial` (i.e. `compile()`) or from `setProgram`
  // during a real render, and these pool meshes are built `visible = false`. So
  // at this moment the pool materials hold NOTHING, `usedTimes` on the warmed
  // program is 1, and disposing the duplicates here would take it to 0 and
  // destroy it — the first shot would compile after all, which is the entire
  // thing the warm-up exists to prevent.
  //
  // Warming one slot is cheap: `acquireProgram` scans by `cacheKey` and finds
  // the program the duplicates already compiled, so this increments `usedTimes`
  // rather than compiling. The other fifteen slots share that cacheKey and hit
  // the same cache the first time they render.
  warmObjectForRender(boltSlots[0]?.mesh, "combat-bolt-pool");
  warmObjectForRender(flashSlots[0]?.mesh, "combat-flash-pool");
  pooledRoot = rootObject;
  return true;
}

/**
 * Compile the two combat material variants without attaching the real pool.
 * Attaching invisible reserve meshes would put them back into every-frame
 * matrix traversal, undoing the optimisation that keeps pools lazy.
 */
function queueCombatWarmup(): void {
  if (combatWarmupQueued) return;
  combatWarmupQueued = true;

  // DUPLICATES of the real pool resources, created only so the shader compiles
  // before the first shot. `temporary` is the honest scope — and it will show as
  // outstanding forever, because nothing disposes these. That is the point:
  // Section D of the plan asks for warm-up resources to have an explicit
  // lifetime, and making the current one visible is the first step to fixing it.
  const warmBoltGeometry = new SphereGeometry(1, 8, 8);
  const warmBoltMaterial = new MeshBasicMaterial({
    color: COMBAT_VFX_BOLT_COLOR,
    toneMapped: false,
  });
  trackResource(warmBoltGeometry, {
    kind: "geometry",
    scope: "temporary",
    label: "combat-bolt-warmup",
  });
  trackResource(warmBoltMaterial, {
    kind: "material",
    scope: "temporary",
    label: "combat-bolt-warmup",
  });
  const bolt = new Mesh(warmBoltGeometry, warmBoltMaterial);
  warmupMeshes.push(bolt);
  const warmFlashGeometry = new SphereGeometry(COMBAT_VFX_FLASH_RADIUS, 8, 8);
  const warmFlashMaterial = new MeshBasicMaterial({
    color: COMBAT_VFX_MUZZLE_COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  trackResource(warmFlashGeometry, {
    kind: "geometry",
    scope: "temporary",
    label: "combat-flash-warmup",
  });
  trackResource(warmFlashMaterial, {
    kind: "material",
    scope: "temporary",
    label: "combat-flash-warmup",
  });
  const flash = new Mesh(warmFlashGeometry, warmFlashMaterial);
  warmupMeshes.push(flash);
  warmObjectForRender(bolt, "combat-bolt");
  warmObjectForRender(flash, "combat-flash");
}

/**
 * Dispose the warm-up duplicates, once doing so is free.
 *
 * Two conditions, and both are load-bearing:
 *
 * 1. **The real pool exists.** It holds the same program, so `usedTimes` is 2
 *    and dropping to 1 keeps the compiled shader. Releasing earlier would take
 *    it to 0 and destroy it, so the first shot would compile after all.
 * 2. **The warm-up queue has drained.** A target still queued would be handed
 *    a disposed material to compile — the same class of use-after-dispose that
 *    produced the `isReady` crash on reset.
 *
 * Retried from `emitAttackVfx` rather than done once, because neither
 * condition is guaranteed at the moment the pool is built. If a session never
 * fires a shot the duplicates survive it — but so does the unbuilt pool, so
 * nothing has been warmed for nothing.
 */
function releaseCombatWarmupResources(): void {
  if (warmupReleased || warmupMeshes.length === 0) return;
  if (boltSlots.length === 0 || flashSlots.length === 0) return;
  // The queue being empty is what proves the two pool warm-ups queued by
  // `ensurePool` have RUN — which is what actually transfers the program. A
  // pool that merely exists has not acquired anything.
  const warmup = gpuWarmupStatus();
  if (warmup.active || warmup.queued > 0) return;

  for (const mesh of warmupMeshes) {
    mesh.geometry.dispose();
    const material = mesh.material as Material | Material[];
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
  }
  warmupMeshes = [];
  warmupReleased = true;
}

function toRootLocal(worldPoint: Vector3): void {
  const rootObject = boardState.boardRoot?.object3D;
  if (rootObject) rootObject.worldToLocal(worldPoint);
}

// Extra Y to raise a point to the entity's rendered body. The drake's model is
// lifted ALIEN_DRAKE_VISUAL_ELEVATION above its ground anchor in structures.ts;
// used for both aim points (targets) and strike points (attackers).
function entityVisualElevation(entity: Entity): number {
  if (
    entity.hasComponent(Enemy) &&
    entity.getValue(Enemy, "kind") === "alienDrake"
  ) {
    return ALIEN_DRAKE_VISUAL_ELEVATION;
  }
  return 0;
}

/**
 * Which weapon this attacker is firing.
 *
 * Exported so the **sound** dispatches on the same decision the **visual** does,
 * rather than on a parallel if-chain that can drift. It drifted once already:
 * phase 1 played the turret zap for every attack, including alien melee, two
 * lines below a comment saying aliens "play a melee energy burst".
 *
 * The key, not the profile — `turret` and `astronaut` share `shape: "laser"`
 * but are different weapons and want different clips.
 */
export function shotProfileKey(attacker: Entity): keyof typeof SHOT_PROFILES {
  if (attacker.hasComponent(Enemy)) {
    const kind = attacker.getValue(Enemy, "kind") ?? "alien";
    return kind in SHOT_PROFILES
      ? (kind as keyof typeof SHOT_PROFILES)
      : "alien";
  }
  if (
    attacker.hasComponent(Building) &&
    attacker.getValue(Building, "kind") === "turret"
  ) {
    return "turret";
  }
  if (attacker.hasComponent(Unit)) {
    const kind = attacker.getValue(Unit, "kind");
    if (kind === "astronaut") return "astronaut";
  }
  // Racer and any other friendly attacker default to plasma.
  return "racer";
}

function shotProfile(attacker: Entity): ShotProfile {
  return SHOT_PROFILES[shotProfileKey(attacker)];
}

function spawnFlash(
  localX: number,
  localY: number,
  localZ: number,
  color: number,
  life: number,
  baseScale: number,
): void {
  for (const slot of flashSlots) {
    if (slot.active) continue;
    slot.active = true;
    slot.age = 0;
    slot.life = life;
    slot.baseScale = baseScale;
    slot.material.color.setHex(color);
    slot.material.opacity = 1;
    slot.mesh.position.set(localX, localY, localZ);
    slot.mesh.scale.setScalar(baseScale);
    slot.mesh.visible = true;
    return;
  }
}

// Fire one bolt from a muzzle (root-local) toward the target body (root-local),
// plus a muzzle flash at the origin. Shape/color/speed come from the profile.
function fireBolt(
  profile: ShotProfile,
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
): void {
  spawnFlash(fromX, fromY, fromZ, profile.muzzleColor, COMBAT_VFX_MUZZLE_FLASH_SECONDS, 0.8);
  for (const slot of boltSlots) {
    if (slot.active) continue;
    slot.active = true;
    slot.toX = toX;
    slot.toY = toY;
    slot.toZ = toZ;
    slot.speed = profile.speed;
    slot.impactColor = profile.impactColor;
    slot.material.color.setHex(profile.boltColor);
    slot.mesh.position.set(fromX, fromY, fromZ);
    if (profile.shape === "laser") {
      slot.mesh.scale.set(
        COMBAT_VFX_LASER_THICKNESS,
        COMBAT_VFX_LASER_THICKNESS,
        COMBAT_VFX_LASER_LENGTH,
      );
      // Orient the stretched local +Z axis along the travel direction.
      tmpDir.set(toX - fromX, toY - fromY, toZ - fromZ);
      if (tmpDir.lengthSq() > 1e-8) {
        tmpDir.normalize();
        slot.mesh.quaternion.setFromUnitVectors(Z_AXIS, tmpDir);
      } else {
        slot.mesh.quaternion.identity();
      }
    } else {
      slot.mesh.scale.setScalar(COMBAT_VFX_BOLT_RADIUS);
      slot.mesh.quaternion.identity();
    }
    slot.mesh.visible = true;
    return;
  }
}

/**
 * Emit muzzle flash + bolt(s) for a real attack event. Visual only — damage is
 * resolved by CombatSystem. Each attacker type has a distinct shot: racer =
 * paired blue plasma from its cannons, astronaut = single green laser, turret =
 * twin orange lasers. Bolts terminate at the target body, never bypassing it.
 */
export function emitAttackVfx(attacker: Entity, target: Entity): void {
  if (!ensurePool()) return;
  const holder = attacker.object3D;
  const targetObject = target.object3D;
  if (!holder || !targetObject) return;
  const profile = shotProfile(attacker);

  // Aim point: target body centre, in root-local space. Add the target's own
  // visual elevation so floating enemies (alienDrake, raised ~0.9 tiles above
  // its ground anchor) are hit on the body, not under it.
  targetObject.getWorldPosition(tmpTarget);
  toRootLocal(tmpTarget);
  tmpTarget.y += COMBAT_VFX_TARGET_BODY_Y + entityVisualElevation(target);
  const toX = tmpTarget.x;
  const toY = tmpTarget.y;
  const toZ = tmpTarget.z;

  // Alien melee: no bolt — a strike flash at the attacker's reach + an impact
  // burst on the target body.
  if (profile.emitter === "melee") {
    holder.getWorldPosition(tmpMuzzle);
    toRootLocal(tmpMuzzle);
    tmpDir.set(toX - tmpMuzzle.x, 0, toZ - tmpMuzzle.z);
    if (tmpDir.lengthSq() > 1e-6) tmpDir.normalize();
    spawnFlash(
      tmpMuzzle.x + tmpDir.x * COMBAT_VFX_MUZZLE_FORWARD,
      tmpMuzzle.y + COMBAT_VFX_MUZZLE_UP + entityVisualElevation(attacker),
      tmpMuzzle.z + tmpDir.z * COMBAT_VFX_MUZZLE_FORWARD,
      profile.muzzleColor,
      COMBAT_VFX_MELEE_STRIKE_SECONDS,
      0.7,
    );
    spawnFlash(toX, toY, toZ, profile.impactColor, COMBAT_VFX_MELEE_BURST_SECONDS, 1.4);
    return;
  }

  // Racer: fire from each named cannon node (paired plasma).
  if (profile.emitter === "nodes") {
    let fired = false;
    for (const nodeName of RACER_CANNON_MUZZLE_NODES) {
      const node = holder.getObjectByName(nodeName);
      if (!node) continue;
      fired = true;
      node.getWorldPosition(tmpMuzzle);
      toRootLocal(tmpMuzzle);
      fireBolt(profile, tmpMuzzle.x, tmpMuzzle.y, tmpMuzzle.z, toX, toY, toZ);
    }
    if (fired) return;
  }

  // Computed muzzle for turret / astronaut: raise from the attacker anchor and
  // step toward the target (all in root-local space).
  holder.getWorldPosition(tmpMuzzle);
  toRootLocal(tmpMuzzle);
  tmpDir.set(toX - tmpMuzzle.x, 0, toZ - tmpMuzzle.z);
  if (tmpDir.lengthSq() > 1e-6) tmpDir.normalize();
  const baseX = tmpMuzzle.x + tmpDir.x * COMBAT_VFX_MUZZLE_FORWARD;
  const baseY = tmpMuzzle.y + COMBAT_VFX_MUZZLE_UP;
  const baseZ = tmpMuzzle.z + tmpDir.z * COMBAT_VFX_MUZZLE_FORWARD;

  if (profile.emitter === "double") {
    // Twin lasers: offset the two muzzles perpendicular to the aim direction.
    tmpPerp.set(tmpDir.z, 0, -tmpDir.x);
    const half = COMBAT_VFX_DOUBLE_SPACING * 0.5;
    fireBolt(
      profile,
      baseX + tmpPerp.x * half,
      baseY,
      baseZ + tmpPerp.z * half,
      toX,
      toY,
      toZ,
    );
    fireBolt(
      profile,
      baseX - tmpPerp.x * half,
      baseY,
      baseZ - tmpPerp.z * half,
      toX,
      toY,
      toZ,
    );
    return;
  }

  fireBolt(profile, baseX, baseY, baseZ, toX, toY, toZ);
}

export function clearCombatEffects(): void {
  for (const slot of boltSlots) {
    slot.active = false;
    slot.mesh.visible = false;
  }
  for (const slot of flashSlots) {
    slot.active = false;
    slot.mesh.visible = false;
    slot.material.opacity = 0;
  }
}

export class CombatEffectsSystem extends createSystem({}) {
  init(): void {
    effectsWorld = this.world;
    queueCombatWarmup();
  }

  update(delta: number): void {
    if (boltSlots.length === 0) return;
    // Retried every frame once the pool exists, not on the next shot. A player
    // who fires once and never again would otherwise keep the duplicates for
    // the rest of the session — the queue is still draining at the moment that
    // single shot is fired.
    releaseCombatWarmupResources();
    const frameDelta = Math.max(0, delta);

    for (const slot of boltSlots) {
      if (!slot.active) continue;
      const position = slot.mesh.position;
      const dx = slot.toX - position.x;
      const dy = slot.toY - position.y;
      const dz = slot.toZ - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= COMBAT_VFX_BOLT_ARRIVAL_EPSILON) {
        slot.active = false;
        slot.mesh.visible = false;
        spawnFlash(
          slot.toX,
          slot.toY,
          slot.toZ,
          slot.impactColor,
          COMBAT_VFX_IMPACT_FLASH_SECONDS,
          1.1,
        );
        continue;
      }
      const step = Math.min(distance, slot.speed * frameDelta);
      const scale = step / distance;
      position.x += dx * scale;
      position.y += dy * scale;
      position.z += dz * scale;
    }

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
  }
}
