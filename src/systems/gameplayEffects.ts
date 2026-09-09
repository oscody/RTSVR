import {
  AdditiveBlending,
  AssetManager,
  Box3,
  type Entity,
  Group,
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
  ALIEN_REMNANT_FADE_SCALE,
  ALIEN_REMNANT_FADE_SECONDS,
  ALIEN_REMNANT_FADE_SINK,
  ALIEN_REMNANT_POOL_SIZE,
  ALIEN_REMNANT_REST_SECONDS,
  ALIEN_REMNANT_TOPPLE_RADIANS,
  ALIEN_REMNANT_TOPPLE_SECONDS,
  COMMAND_CENTER_DOOR_NODES,
  GAMEPLAY_VFX_CARRY_ARRIVE_FRACTION,
  GAMEPLAY_VFX_CARRY_POOL_SIZE,
  GAMEPLAY_VFX_CARRY_SPIN,
  GAMEPLAY_VFX_CARRY_STOP_SHORT,
  GAMEPLAY_VFX_CARRY_WIDTH,
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
import { startRetreat } from "./objectTransitions.js";
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

/**
 * One crystal in flight from a miner to the command center.
 *
 * `owner` is the miner's entity index rather than the entity, so a slot can be
 * cancelled by a caller that no longer has the entity — which is exactly the
 * case that matters, a miner killed mid-deposit.
 *
 * NOTE the index-recycling hazard: `entity.index` is pooled and reused, so a
 * slot MUST be released the moment its flight ends or its miner stops mining.
 * A stale slot still claiming index 12 would be cancelled by whatever unit is
 * handed index 12 next.
 */
interface CarrySlot {
  object: Object3D;
  active: boolean;
  age: number;
  life: number;
  owner: number;
  from: Vector3;
  to: Vector3;
}

/**
 * A killed alien's body, going over.
 *
 * No `owner`: unlike a carry, nothing ever needs to cancel one. The entity it
 * came from is already destroyed when the slot is claimed, so there is no
 * lifetime to stay in step with — which is also why it needs no death hook of
 * its own beyond the one call.
 */
interface RemnantSlot {
  object: Object3D;
  active: boolean;
  age: number;
  /** Sign of the topple, so bodies do not all fall the same way. */
  direction: number;
  /** `startRetreat` is handed the object once, at the end of the rest. */
  fading: boolean;
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
const carrySlots: CarrySlot[] = [];
const remnantSlots: RemnantSlot[] = [];
let pooledRoot: Object3D | null = null;
let effectsWorld: World | null = null;

// Scratch, reused across events. Allocating a Vector3 per death would put a
// GC pause exactly where the frame is already busiest.
const tmpWorld = new Vector3();
const tmpTarget = new Vector3();
const tmpDoor = new Vector3();

/**
 * The four door pivots, resolved once per command center.
 *
 * `getObjectByName` walks the whole building, so it is done on the first
 * hand-over and kept until the command center object changes — which is what a
 * scenario reset produces. The BOX of each door is still measured fresh at every
 * launch, because the doors are open by then and their geometry has moved.
 */
let doorNodes: Object3D[] = [];
let doorSource: Object3D | null = null;

/**
 * World-space centre of the door nearest `fromWorld`, written into `out`.
 *
 * Returns false when the model has no door nodes, which is the fallback the
 * caller handles — a different command center asset should degrade to a sane
 * flight, not to no deposit visual.
 */
function nearestDoor(commandCenter: Object3D, fromWorld: Vector3, out: Vector3): boolean {
  if (doorSource !== commandCenter) {
    doorSource = commandCenter;
    doorNodes = [];
    for (const name of COMMAND_CENTER_DOOR_NODES) {
      const node = commandCenter.getObjectByName(name);
      if (node) doorNodes.push(node);
    }
  }
  let best = Infinity;
  for (const node of doorNodes) {
    // The BOX, not the node position: these pivots all sit at the model origin
    // and the door geometry is baked into the vertices below them, so every
    // node position would resolve to the same point in the middle of the base.
    tmpBox.setFromObject(node);
    // An empty box means the node has no mesh under it any more — a merge rule
    // change, or a different asset. `getCenter` answers (0,0,0) for an empty
    // box, which is the BOARD ORIGIN: the crystal would sail off to the corner
    // of the map with nothing in the log to say why. Skip it and let the
    // fallback aim at the building instead.
    if (tmpBox.isEmpty()) continue;
    tmpBox.getCenter(tmpDoor);
    const distance = tmpDoor.distanceToSquared(fromWorld);
    if (distance >= best) continue;
    best = distance;
    out.copy(tmpDoor);
  }
  return best < Infinity;
}
const tmpSize = new Vector3();
const tmpBox = new Box3();

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
  carrySlots.length = 0;

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

/**
 * Build the crystal pool, which is deliberately NOT part of {@link ensurePool}.
 *
 * The flash and pulse pools need only a board root. This one needs a loaded
 * GLTF, and the two are not ready at the same moment: the root exists during
 * the loading screen, while `rockCrystals` arrives whenever the manifest gets
 * to it. Built inside `ensurePool`, an early call would find no asset, take
 * the identity-check early return on every later frame, and leave the game
 * permanently without a hand-over visual — failing silently, which is the
 * worst way for an effect to fail.
 *
 * So it retries. Cheap to call every frame: one length check once it is built,
 * and one map lookup while it is not.
 */
function ensureCarryPool(): boolean {
  if (carrySlots.length > 0) return true;
  const root = boardState.boardRoot;
  if (!root || !root.object3D || !effectsWorld) return false;
  // Asked ONCE, before anything is built. Checking per iteration could leave a
  // half-built pool parented to the board with its slots discarded — invisible,
  // undisposed, and rebuilt again on the next frame.
  if (!AssetManager.getGLTF("rockCrystals")?.scene) return false;

  for (let index = 0; index < GAMEPLAY_VFX_CARRY_POOL_SIZE; index += 1) {
    // The crystal in flight is a clone of the model the miner carries, not an
    // abstract shard: the point of the effect is that the rock you watched it
    // pick up is the rock that goes in. `getGLTF` hands back a fresh clone per
    // call, so the slots do not share a scene graph.
    const crystal = AssetManager.getGLTF("rockCrystals")?.scene;
    if (!crystal) break;

    // A HOLDER is flown, not the model itself, and the model carries the
    // centring offset inside it. The two cannot be the same object: the flight
    // writes `object.position` every frame, which would overwrite any offset
    // stored there and put the pivot back wherever the GLB happens to keep it.
    // The miner's cargo seats this same GLB on the ground (`seatModel` in
    // craftFactory); a crystal in flight has no ground, so it is centred on all
    // three axes instead, or it would swing around the path rather than follow
    // along it.
    tmpBox.setFromObject(crystal).getCenter(tmpTarget);
    crystal.position.sub(tmpTarget);
    const width = tmpBox.getSize(tmpSize).x || 1;

    const holder = new Group();
    holder.add(crystal);
    holder.scale.setScalar(GAMEPLAY_VFX_CARRY_WIDTH / width);
    holder.visible = false;
    makeNonInteractive(holder);
    holder.name = `GameplayCarry_${index}`;
    // Inherited by every child mesh when the draw census walks the tree, so
    // these land in the `vfx` bucket rather than silently inflating `static`.
    holder.userData.drawCat = "vfx";
    // Same as every other pool here: an ECS entity under the board root, never
    // a bare `object3D.add`, so it takes part in the level lifecycle.
    effectsWorld.createTransformEntity(holder, { parent: root });
    carrySlots.push({
      object: holder,
      active: false,
      age: 0,
      life: 0,
      owner: -1,
      from: new Vector3(),
      to: new Vector3(),
    });
  }
  warmObjectForRender(carrySlots[0]?.object, "gameplay-carry-pool");
  return carrySlots.length > 0;
}

/**
 * Build the remnant pool. Separate from {@link ensurePool} for the same reason
 * as {@link ensureCarryPool}: it waits on a loaded GLTF, not just a board root.
 *
 * Clones the STATIC `alien` asset, not `alienWalkingSlam`. A corpse must not be
 * mid-stride, and the static variant also carries no mixer to warm or stop.
 */
function ensureRemnantPool(): boolean {
  if (remnantSlots.length > 0) return true;
  const root = boardState.boardRoot;
  if (!root || !root.object3D || !effectsWorld) return false;
  if (!AssetManager.getGLTF("alien")?.scene) return false;

  for (let index = 0; index < ALIEN_REMNANT_POOL_SIZE; index += 1) {
    const body = AssetManager.getGLTF("alien")?.scene;
    if (!body) break;
    const holder = new Group();
    holder.add(body);
    holder.visible = false;
    makeNonInteractive(holder);
    holder.name = `AlienRemnant_${index}`;
    // Its OWN census bucket, not `vfx` and not `alien`: Phase 2 has to be able
    // to read what remnants cost off the `Draw` line without unpicking them
    // from live aliens or from the flash pools.
    holder.userData.drawCat = "remnant";
    effectsWorld.createTransformEntity(holder, { parent: root });
    remnantSlots.push({ object: holder, active: false, age: 0, direction: 1, fading: false });
  }
  warmObjectForRender(remnantSlots[0]?.object, "gameplay-remnant-pool");
  return remnantSlots.length > 0;
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
 * A miner has reached the base and is handing its load over.
 *
 * Called on the ARRIVAL edge, not the credit: the flight fills the deposit
 * stage that the arrival opens. `seconds` is the stage length, and the flight
 * itself takes {@link GAMEPLAY_VFX_CARRY_ARRIVE_FRACTION} of it so the crystal
 * is home before the stockpile moves.
 *
 * Presentation only, like everything else here — the crystals are credited by
 * `advanceMiningCycle`, on its own timer. If this drops the visual because the
 * pool is full, the deposit still happens exactly as it would have.
 */
export function startCrystalCarry(
  miner: Entity | null,
  commandCenter: Entity | null,
  seconds: number,
): void {
  if (!miner?.object3D || !commandCenter?.object3D) return;
  if (!ensureCarryPool() || seconds <= 0) return;

  // The hand-over starts where the cargo actually sits — on top of the miner —
  // rather than at its feet, so the crystal does not jump on the first frame.
  const cargo = boardState.cargoVisualByUnit.get(miner.index);
  if (cargo) cargo.getWorldPosition(tmpWorld);
  else {
    miner.object3D.getWorldPosition(tmpWorld);
    tmpWorld.y += GAMEPLAY_VFX_BODY_Y;
  }
  // Into the door that just opened — the nearest of the four, which is the one
  // on the side the miner walked up to.
  if (nearestDoor(commandCenter.object3D, tmpWorld, tmpTarget)) {
    toRootLocal(tmpWorld);
    toRootLocal(tmpTarget);
  } else {
    commandCenter.object3D.getWorldPosition(tmpTarget);
    tmpTarget.y += GAMEPLAY_VFX_BODY_Y;
    toRootLocal(tmpWorld);
    toRootLocal(tmpTarget);
    tmpTarget.lerp(tmpWorld, GAMEPLAY_VFX_CARRY_STOP_SHORT);
  }

  // One flight per miner. A second call for a miner already carrying restarts
  // that slot instead of consuming a new one, so a re-issued order cannot leak.
  const slot =
    carrySlots.find((candidate) => candidate.active && candidate.owner === miner.index) ??
    carrySlots.find((candidate) => !candidate.active);
  if (!slot) return; // Pool full: drop it. See the module comment.

  slot.active = true;
  slot.age = 0;
  slot.life = seconds * GAMEPLAY_VFX_CARRY_ARRIVE_FRACTION;
  slot.owner = miner.index;
  slot.from.copy(tmpWorld);
  slot.to.copy(tmpTarget);
  slot.object.position.copy(tmpWorld);
  // Reset rather than let it accumulate: a slot reused every trip for a long
  // match would otherwise carry an ever-growing angle into float territory
  // where the spin visibly stutters.
  slot.object.rotation.y = 0;
  slot.object.visible = true;
}

/**
 * A killed alien leaves its body, which goes over and lies there.
 *
 * Called from the combat kill path only, and — like every emitter here — while
 * the target's `Object3D` still exists, since the pose is copied off it. The
 * remnant then lives entirely on its own: the entity is destroyed on the same
 * frame and nothing links the two afterwards.
 *
 * Phase 1 scope: the basic walker. Drakes die in the air and a mech falling like
 * a body would look wrong; both wait for Phase 3 and its own timing profile.
 */
export function startAlienRemnant(target: Entity | null, kind: string): void {
  if (kind !== "alien" || !target?.object3D || !ensureRemnantPool()) return;

  const slot = remnantSlots.find((candidate) => !candidate.active);
  if (!slot) return; // Pool full: drop it, exactly as the flash pools do.

  target.object3D.getWorldPosition(tmpWorld);
  toRootLocal(tmpWorld);
  slot.object.position.copy(tmpWorld);
  // Keep the facing it died with, and reset everything a previous life left
  // behind — `startRetreat` restores scale and Y but never the topple.
  slot.object.rotation.set(0, target.object3D.rotation.y, 0);
  slot.object.scale.setScalar(1);
  slot.active = true;
  slot.age = 0;
  slot.fading = false;
  slot.direction = Math.random() < 0.5 ? -1 : 1;
  slot.object.visible = true;
}

/**
 * Abandon a hand-over that will never be paid.
 *
 * Called wherever a miner stops mining — the base destroyed under it, the
 * player reassigning it, the miner killed. Without this the crystal would fly
 * on and land, showing a delivery the stockpile never received.
 */
export function cancelCrystalCarry(minerIndex: number): void {
  for (const slot of carrySlots) {
    if (!slot.active || slot.owner !== minerIndex) continue;
    slot.active = false;
    slot.owner = -1;
    slot.object.visible = false;
  }
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
  for (const slot of carrySlots) {
    slot.active = false;
    slot.owner = -1;
    slot.object.visible = false;
  }
  for (const slot of remnantSlots) {
    slot.active = false;
    slot.fading = false;
    slot.object.visible = false;
  }
  // Drop the door lookup with them. A reset builds a new command center, and
  // holding its predecessor's nodes would keep a disposed subtree alive until
  // the next hand-over happened to notice the object had changed.
  doorSource = null;
  doorNodes = [];
}

/** Diagnostic surface: how many slots are live right now. */
export function gameplayEffectsActive(): {
  flashes: number;
  pulses: number;
  carries: number;
  remnants: number;
} {
  let flashes = 0;
  let pulses = 0;
  let carries = 0;
  for (const slot of flashSlots) if (slot.active) flashes += 1;
  for (const slot of pulseSlots) if (slot.active) pulses += 1;
  let remnants = 0;
  for (const slot of carrySlots) if (slot.active) carries += 1;
  for (const slot of remnantSlots) if (slot.active) remnants += 1;
  return { flashes, pulses, carries, remnants };
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
    // Retry until their assets have loaded; a no-op length check after that.
    ensureCarryPool();
    ensureRemnantPool();
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

    for (const slot of carrySlots) {
      if (!slot.active) continue;
      slot.age += frameDelta;
      const t = slot.age / slot.life;
      if (t >= 1) {
        // Released the frame it lands. The slot is keyed on a POOLED entity
        // index, so holding it a moment longer than the flight risks a later
        // unit inheriting the index and cancelling a stranger's delivery.
        slot.active = false;
        slot.owner = -1;
        slot.object.visible = false;
        continue;
      }
      // A GLIDE, not a throw: straight from where the miner set it down to the
      // open door, on a smoothstep so it eases away and settles into the
      // doorway instead of stopping dead. There is deliberately no arc — an arc
      // reads as the crystal being lobbed, and it is being carried in.
      const eased = t * t * (3 - 2 * t);
      slot.object.position.lerpVectors(slot.from, slot.to, eased);
      slot.object.rotation.y += frameDelta * GAMEPLAY_VFX_CARRY_SPIN;
    }

    for (const slot of remnantSlots) {
      if (!slot.active) continue;
      slot.age += frameDelta;

      if (slot.age < ALIEN_REMNANT_TOPPLE_SECONDS) {
        // t-squared, so the body starts slow and accelerates into the ground.
        // The model is seated on its base, so rotating the holder pivots it
        // about its feet — no fall on Y is needed, and none is applied: a live
        // alien already stands on the ground.
        const t = slot.age / ALIEN_REMNANT_TOPPLE_SECONDS;
        slot.object.rotation.x = slot.direction * ALIEN_REMNANT_TOPPLE_RADIANS * t * t;
        continue;
      }
      slot.object.rotation.x = slot.direction * ALIEN_REMNANT_TOPPLE_RADIANS;

      if (slot.age < ALIEN_REMNANT_TOPPLE_SECONDS + ALIEN_REMNANT_REST_SECONDS) continue;

      if (!slot.fading) {
        // Reuse rather than a second easing curve. `startRetreat` shrinks it,
        // sinks it and hides it at the end; a full transition pool snaps it
        // away instead, which is the right degradation.
        slot.fading = true;
        startRetreat(
          slot.object,
          ALIEN_REMNANT_FADE_SECONDS,
          ALIEN_REMNANT_FADE_SCALE,
          ALIEN_REMNANT_FADE_SINK,
        );
      }
      if (
        slot.age >=
        ALIEN_REMNANT_TOPPLE_SECONDS + ALIEN_REMNANT_REST_SECONDS + ALIEN_REMNANT_FADE_SECONDS
      ) {
        slot.active = false;
        slot.fading = false;
      }
    }
  }
}
