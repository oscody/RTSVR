import {
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
  for (let index = 0; index < COMBAT_VFX_BOLT_POOL_SIZE; index += 1) {
    // Solid + toneMapped:false so the hue renders true. Additive blending over
    // the bright board washed every bolt to white, so bolts are NOT additive.
    const material = new MeshBasicMaterial({
      color: COMBAT_VFX_BOLT_COLOR,
      toneMapped: false,
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

  pooledRoot = rootObject;
  return true;
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

function shotProfile(attacker: Entity): ShotProfile {
  if (attacker.hasComponent(Enemy)) {
    const kind = attacker.getValue(Enemy, "kind") ?? "alien";
    return SHOT_PROFILES[kind] ?? SHOT_PROFILES.alien;
  }
  if (
    attacker.hasComponent(Building) &&
    attacker.getValue(Building, "kind") === "turret"
  ) {
    return SHOT_PROFILES.turret;
  }
  if (attacker.hasComponent(Unit)) {
    const kind = attacker.getValue(Unit, "kind");
    if (kind === "astronaut") return SHOT_PROFILES.astronaut;
  }
  // Racer and any other friendly attacker default to plasma.
  return SHOT_PROFILES.racer;
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
  }

  update(delta: number): void {
    if (boltSlots.length === 0) return;
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
