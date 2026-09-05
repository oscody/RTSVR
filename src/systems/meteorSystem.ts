import {
  AdditiveBlending,
  AssetManager,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  createSystem,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { GRID_SIZE, TILE_SIZE, gridToWorld } from "./board.js";
import { makeNonInteractive } from "./sharedGeometry.js";
import {
  METEOR_ARRIVAL_EPSILON,
  METEOR_CYCLE_GAP_SECONDS,
  METEOR_DEPART_SECONDS,
  METEOR_DEPART_SINK,
  METEOR_MATERIALIZE_RISE,
  METEOR_MATERIALIZE_SECONDS,
  METEOR_MATERIALIZE_START_SCALE,
  METEOR_FALL_ACCEL,
  METEOR_FALL_SPEED,
  METEOR_FLOAT_BOB,
  METEOR_FLOAT_HEIGHT,
  METEOR_FLOAT_SECONDS,
  METEOR_IMPACT_COLOR,
  METEOR_IMPACT_FLASH_RADIUS,
  METEOR_IMPACT_FLASH_SECONDS,
  METEOR_POOL_SIZE,
  METEOR_REST_SECONDS,
  METEOR_REST_Y_OFFSET,
  METEOR_SIZE_TILES,
  METEOR_SPIN_RATE,
  METEOR_STAGGER_SECONDS,
  METEOR_TRAIL_COLOR,
  METEOR_TRAIL_LENGTH,
  METEOR_TRAIL_THICKNESS,
} from "./constants.ts";
import { warmObjectForRender } from "./gpuWarmup.js";
import { MatchState, WaveSource, boardState, getTerrainAt } from "./state.js";
import { TUTORIAL_WAVE_NUMBER } from "./waveCatalog.js";
import { trackResource, tracked } from "./resourceLifetime.js";
import {
  departPose,
  materializePose,
  transitionProgress,
} from "./transitionRules.ts";

// One synchronized batch: the rocks float, fall together, rest, then vanish and
// the cycle restarts. "idle" is the gap between cycles.
type MeteorPhase =
  | "idle"
  | "materializing" // easing in from small-and-low, before the hover
  | "floating"
  | "falling"
  | "resting"
  | "departing"; // shrinking and sinking, before the slot is parked

interface MeteorSlot {
  holder: Group;
  spinner: Group; // holds the centered rock; spins IN PLACE so it never drifts
  trail: Mesh; // glow streak; only visible during the fall
  used: boolean; // participating in the current cycle
  released: boolean; // has begun its drop (else still hovering)
  landed: boolean;
  speed: number;
  toX: number;
  toY: number;
  toZ: number;
  floatY: number;
  bobOffset: number;
  spinX: number;
  spinY: number;
  /**
   * Y this slot began its departure from.
   *
   * Sampled when the departure starts rather than assumed to be the landed
   * height, because a match can end mid-fall — the rock then shrinks and sinks
   * from wherever it actually is instead of snapping to the ground first.
   */
  departFromY: number;
}

interface FlashSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  active: boolean;
  age: number;
}

const meteorSlots: MeteorSlot[] = [];
const flashSlots: FlashSlot[] = [];
let pooledRoot: Object3D | null = null;
let meteorWorld: World | null = null;

let phase: MeteorPhase = "idle";
let phaseTimer = METEOR_CYCLE_GAP_SECONDS;
let releaseTimer = 0; // counts down to releasing the next rock during the fall
let bobPhase = 0;

const tmpBox = new Box3();
const tmpSize = new Vector3();

const METEOR_ASSETS = ["meteor", "meteorDetailed"] as const;

function ensurePool(): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !meteorWorld) return false;
  if (pooledRoot === rootObject && meteorSlots.length > 0) return true;

  meteorSlots.length = 0;
  flashSlots.length = 0;

  for (let index = 0; index < METEOR_POOL_SIZE; index += 1) {
    const asset = METEOR_ASSETS[index % METEOR_ASSETS.length];
    const model = AssetManager.getGLTF(asset)?.scene;
    if (!model) return false; // assets not loaded yet — retry next frame
    const width = tmpBox.setFromObject(model).getSize(tmpSize).x || TILE_SIZE;
    model.scale.setScalar((METEOR_SIZE_TILES * TILE_SIZE) / width);
    // Center the rock's geometry on its OWN origin, then spin the wrapping
    // group. Spinning the model directly would orbit the off-center geometry
    // and drift it away from the trail; spinning a centered group tumbles in
    // place so the rock and its trail stay locked together.
    tmpBox.setFromObject(model).getCenter(tmpSize);
    model.position.x -= tmpSize.x;
    model.position.y -= tmpSize.y;
    model.position.z -= tmpSize.z;
    const spinner = new Group();
    spinner.add(model);

    // Per slot, unlike the combat pool: each meteor's trail is built inside the
    // loop, so geometry and material are both per-slot here.
    const trailGeometry = new SphereGeometry(1, 8, 8);
    trackResource(trailGeometry, {
      kind: "geometry",
      scope: "pool",
      label: "meteor-trail",
      owner: `slot:${index}`,
    });
    const trail = new Mesh(
      trailGeometry,
      tracked(new MeshBasicMaterial({
        color: METEOR_TRAIL_COLOR,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }), "material", "pool", "meteor-trail", `slot:${index}`),
    );

    makeNonInteractive(trail);
    // Vertical streak directly ABOVE the rock. The rock falls straight down, so
    // its tail always points straight up — no holder rotation needed (which
    // wouldn't survive the Transform binding anyway).
    trail.scale.set(
      METEOR_TRAIL_THICKNESS,
      METEOR_TRAIL_LENGTH,
      METEOR_TRAIL_THICKNESS,
    );
    trail.position.y = METEOR_TRAIL_LENGTH * 0.5;
    trail.frustumCulled = false;

    const holder = new Group();
    holder.name = `Meteor_${index}`;
    holder.visible = false;
    holder.userData.drawCat = "meteor"; // draw-call profiler category
    holder.add(spinner);
    holder.add(trail);
    meteorWorld.createTransformEntity(holder, { parent: root });
    meteorSlots.push({
      holder,
      spinner,
      trail,
      used: false,
      released: false,
      landed: false,
      speed: 0,
      toX: 0,
      toY: 0,
      toZ: 0,
      floatY: METEOR_FLOAT_HEIGHT,
      bobOffset: 0,
      spinX: 0,
      spinY: 0,
      departFromY: METEOR_FLOAT_HEIGHT,
    });
  }

  const flashGeometry = new SphereGeometry(METEOR_IMPACT_FLASH_RADIUS, 10, 10);
  trackResource(flashGeometry, {
    kind: "geometry",
    scope: "pool",
    label: "meteor-impact-flash",
  });
  for (let index = 0; index < METEOR_POOL_SIZE; index += 1) {
    const material = new MeshBasicMaterial({
      color: METEOR_IMPACT_COLOR,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    trackResource(material, {
      kind: "material",
      scope: "pool",
      label: "meteor-impact-flash",
      owner: `slot:${index}`,
    });
    const mesh = new Mesh(flashGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `MeteorImpact_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    meteorWorld.createTransformEntity(mesh, { parent: root });
    flashSlots.push({ mesh, material, active: false, age: 0 });
  }

  pooledRoot = rootObject;
  // Compile the two meteor model variants plus their trail/impact materials
  // before a normal match's first ambient shower.
  warmObjectForRender(meteorSlots[0]?.spinner, "meteor:base");
  warmObjectForRender(meteorSlots[1]?.spinner, "meteor:detailed");
  warmObjectForRender(meteorSlots[0]?.trail, "meteor:trail");
  warmObjectForRender(flashSlots[0]?.mesh, "meteor:impact");
  return true;
}

// Random distinct OPEN tiles (never lands on already-blocked terrain).
function pickOpenTiles(count: number): Array<[number, number]> {
  const tiles: Array<[number, number]> = [];
  const used = new Set<number>();
  const maxAttempts = count * 60;
  for (let attempt = 0; attempt < maxAttempts && tiles.length < count; attempt += 1) {
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const key = y * GRID_SIZE + x;
    if (used.has(key)) continue;
    if (getTerrainAt(x, y) !== "open") continue;
    used.add(key);
    tiles.push([x, y]);
  }
  return tiles;
}

function startCycle(): void {
  const tiles = pickOpenTiles(METEOR_POOL_SIZE);
  for (const slot of meteorSlots) {
    slot.used = false;
    slot.holder.visible = false;
  }
  for (let index = 0; index < tiles.length && index < meteorSlots.length; index += 1) {
    const slot = meteorSlots[index];
    const [gx, gy] = tiles[index];
    const [worldX, worldZ] = gridToWorld(gx, gy);
    slot.used = true;
    slot.released = false;
    slot.landed = false;
    slot.speed = METEOR_FALL_SPEED;
    slot.toX = worldX;
    slot.toY = 0.02;
    slot.toZ = worldZ;
    slot.floatY = METEOR_FLOAT_HEIGHT;
    slot.bobOffset = Math.random() * Math.PI * 2;
    slot.spinX = (Math.random() * 2 - 1) * METEOR_SPIN_RATE;
    slot.spinY = (Math.random() * 2 - 1) * METEOR_SPIN_RATE;
    slot.departFromY = METEOR_FLOAT_HEIGHT;
    // Enter small and low; `updateMaterializing` eases both to the hover pose.
    const entry = materializePose(
      0,
      METEOR_MATERIALIZE_START_SCALE,
      METEOR_FLOAT_HEIGHT,
      METEOR_MATERIALIZE_RISE,
    );
    slot.holder.position.set(worldX, entry.y, worldZ);
    slot.holder.scale.setScalar(entry.scale);
    slot.spinner.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    slot.trail.visible = false; // hidden while hovering
    slot.holder.visible = true;
  }
  phase = tiles.length > 0 ? "materializing" : "idle";
  phaseTimer =
    tiles.length > 0 ? METEOR_MATERIALIZE_SECONDS : METEOR_CYCLE_GAP_SECONDS;
}

function spawnImpact(x: number, y: number, z: number): void {
  for (const slot of flashSlots) {
    if (slot.active) continue;
    slot.active = true;
    slot.age = 0;
    slot.material.opacity = 1;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.setScalar(1);
    slot.mesh.visible = true;
    return;
  }
}

/**
 * Begin a graceful exit for whatever is currently on the board.
 *
 * Each slot records where it is NOW as its departure origin, so a batch caught
 * mid-fall by a victory sinks from mid-air rather than teleporting to the
 * ground first. Called both when a batch finishes resting and when a match
 * ends — the difference between those is only where the rocks happen to be.
 */
function beginDeparture(): void {
  let any = false;
  for (const slot of meteorSlots) {
    if (!slot.used) continue;
    slot.departFromY = slot.holder.position.y;
    slot.trail.visible = false; // no streak on the way out
    any = true;
  }
  if (!any) {
    phase = "idle";
    phaseTimer = METEOR_CYCLE_GAP_SECONDS;
    return;
  }
  phase = "departing";
  phaseTimer = METEOR_DEPART_SECONDS;
}

export function clearMeteors(): void {
  for (const slot of meteorSlots) {
    slot.used = false;
    slot.released = false;
    slot.landed = false;
    slot.holder.visible = false;
    // Restore the transform the transitions animate. Without this a Restart
    // during a materialise or departure leaves the slot at a fractional scale,
    // and the next cycle's rock enters at the wrong size.
    slot.holder.scale.setScalar(1);
  }
  for (const slot of flashSlots) {
    slot.active = false;
    slot.mesh.visible = false;
    slot.material.opacity = 0;
  }
  phase = "idle";
  phaseTimer = METEOR_CYCLE_GAP_SECONDS;
}

export class MeteorSystem extends createSystem({}) {
  init(): void {
    meteorWorld = this.world;
  }

  update(delta: number): void {
    if (!ensurePool()) return;

    // Stop the shower when the match is over (victory/defeat/restarting), and
    // for the whole of the tutorial level. Clear any in-flight rocks once; the
    // cycle resumes when play restarts, or when wave 0 is cleared and the
    // normal ladder begins.
    //
    // The tutorial's entire job is directing attention: a bobbing cone points
    // at one thing and the card names it. Rocks streaking down with additive
    // trails and impact flashes are a competing motion cue, several times a
    // minute, aimed at nothing. Ambient spectacle is right for a normal match
    // and wrong while someone is being taught.
    //
    // Keyed on the WAVE NUMBER rather than on the tutorial gate, so the shower
    // returns the moment wave 0 is cleared rather than staying off for the rest
    // of the session — and so a disabled tutorial, which never reaches wave 0,
    // is untouched without this file knowing anything about the tutorial.
    const source = boardState.waveSource;
    const status = source?.getValue(MatchState, "status") ?? "playing";
    const waveNumber = source?.getValue(WaveSource, "waveNumber") ?? 1;
    // Two different exits, deliberately.
    //
    // Tutorial suppression is IMMEDIATE: the shower is a competing motion cue
    // aimed at nothing while someone is being taught, so it has to stop being
    // one this frame rather than over the next half second.
    if (waveNumber === TUTORIAL_WAVE_NUMBER) {
      if (phase !== "idle") clearMeteors();
      return;
    }
    // A match ending is GRACEFUL: rocks shrink and sink from wherever they are.
    // The departure must keep advancing after the status changes, or it would
    // freeze half-shrunk on the board behind the result panel.
    if (status !== "playing") {
      if (phase !== "idle" && phase !== "departing") beginDeparture();
      if (phase === "departing") {
        this.updateDeparting(Math.max(0, delta));
        this.updateFlashes(Math.max(0, delta));
      }
      return;
    }

    const frameDelta = Math.max(0, delta);

    switch (phase) {
      case "idle":
        phaseTimer -= frameDelta;
        if (phaseTimer <= 0) startCycle();
        break;
      case "floating":
        this.updateFloating(frameDelta);
        break;
      case "falling":
        this.updateFalling(frameDelta);
        break;
      case "resting":
        phaseTimer -= frameDelta;
        if (phaseTimer <= 0) beginDeparture();
        break;
      case "materializing":
        this.updateMaterializing(frameDelta);
        break;
      case "departing":
        this.updateDeparting(frameDelta);
        break;
    }

    this.updateFlashes(frameDelta);
  }

  /**
   * Ease a fresh batch in from small-and-low to its hover pose.
   *
   * Scale and Y only — the rocks keep their own materials, because these models
   * come from `AssetManager` and their materials are shared with every clone.
   * Fading one would fade them all.
   */
  private updateMaterializing(delta: number): void {
    phaseTimer -= delta;
    const t = transitionProgress(phaseTimer, METEOR_MATERIALIZE_SECONDS);
    for (const slot of meteorSlots) {
      if (!slot.used) continue;
      const pose = materializePose(
        t,
        METEOR_MATERIALIZE_START_SCALE,
        slot.floatY,
        METEOR_MATERIALIZE_RISE,
      );
      slot.holder.scale.setScalar(pose.scale);
      slot.holder.position.y = pose.y;
    }
    if (t < 1) return;
    // Settle exactly, so floating starts from the pose it expects rather than
    // wherever the last frame's easing happened to land.
    for (const slot of meteorSlots) {
      if (!slot.used) continue;
      slot.holder.scale.setScalar(1);
      slot.holder.position.y = slot.floatY;
    }
    phase = "floating";
    phaseTimer = METEOR_FLOAT_SECONDS;
  }

  /**
   * Shrink and sink a finished batch, then park it.
   *
   * Each rock leaves from its own `departFromY`, so a batch caught mid-fall by
   * a match ending departs from where it is rather than snapping down first.
   */
  private updateDeparting(delta: number): void {
    phaseTimer -= delta;
    const t = transitionProgress(phaseTimer, METEOR_DEPART_SECONDS);
    for (const slot of meteorSlots) {
      if (!slot.used) continue;
      const pose = departPose(t, slot.departFromY, METEOR_DEPART_SINK);
      slot.holder.scale.setScalar(pose.scale);
      slot.holder.position.y = pose.y;
    }
    if (t < 1) return;
    // Park AND restore the transform. A slot left half-shrunk would make the
    // next cycle's rock enter at the wrong size.
    for (const slot of meteorSlots) {
      slot.used = false;
      slot.holder.visible = false;
      slot.holder.scale.setScalar(1);
    }
    phase = "idle";
    phaseTimer = METEOR_CYCLE_GAP_SECONDS;
  }

  private updateFloating(delta: number): void {
    bobPhase += delta;
    for (const slot of meteorSlots) {
      if (!slot.used) continue;
      slot.holder.position.y =
        slot.floatY + Math.sin(bobPhase + slot.bobOffset) * METEOR_FLOAT_BOB;
      slot.spinner.rotation.y += slot.spinY * 0.3 * delta;
    }
    phaseTimer -= delta;
    if (phaseTimer <= 0) {
      phase = "falling";
      releaseTimer = 0; // drop the first rock immediately, then stagger the rest
    }
  }

  private updateFalling(delta: number): void {
    // Release one hovering rock at a time.
    releaseTimer -= delta;
    if (releaseTimer <= 0) {
      const next = meteorSlots.find((slot) => slot.used && !slot.released);
      if (next) {
        next.released = true;
        next.trail.visible = true;
        releaseTimer = METEOR_STAGGER_SECONDS;
      }
    }

    bobPhase += delta;
    let allLanded = true;
    for (const slot of meteorSlots) {
      if (!slot.used) continue;
      if (slot.landed) continue;
      allLanded = false;

      if (!slot.released) {
        // still waiting its turn — keep hovering
        slot.holder.position.y =
          slot.floatY + Math.sin(bobPhase + slot.bobOffset) * METEOR_FLOAT_BOB;
        slot.spinner.rotation.y += slot.spinY * 0.3 * delta;
        continue;
      }

      slot.speed += METEOR_FALL_ACCEL * delta;
      slot.holder.position.y -= slot.speed * delta;
      slot.spinner.rotation.x += slot.spinX * delta;
      slot.spinner.rotation.y += slot.spinY * delta;
      if (slot.holder.position.y <= slot.toY + METEOR_ARRIVAL_EPSILON) {
        slot.holder.position.set(slot.toX, slot.toY + METEOR_REST_Y_OFFSET, slot.toZ);
        slot.holder.quaternion.identity();
        slot.trail.visible = false;
        spawnImpact(slot.toX, slot.toY, slot.toZ);
        slot.landed = true;
      }
    }
    if (allLanded) {
      phase = "resting";
      phaseTimer = METEOR_REST_SECONDS;
    }
  }

  private updateFlashes(delta: number): void {
    for (const slot of flashSlots) {
      if (!slot.active) continue;
      slot.age += delta;
      const t = slot.age / METEOR_IMPACT_FLASH_SECONDS;
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      slot.material.opacity = 1 - t;
      slot.mesh.scale.setScalar(1 + t * 2.5);
    }
  }
}

