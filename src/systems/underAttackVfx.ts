import {
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture,
  Vector3,
  createSystem,
  type Entity,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  UNDER_ATTACK_BADGE_BOB,
  UNDER_ATTACK_BADGE_BOB_HZ,
  UNDER_ATTACK_BADGE_ATTACK_GLYPH,
  UNDER_ATTACK_BADGE_ATTACK_SECONDS,
  UNDER_ATTACK_BADGE_LOCKED_GLYPH,
  UNDER_ATTACK_BADGE_LINGER_SECONDS,
  UNDER_ATTACK_BADGE_OUT_SECONDS,
  UNDER_ATTACK_BADGE_POOL_SIZE,
  UNDER_ATTACK_BADGE_POP_OVERSHOOT,
  UNDER_ATTACK_BADGE_POP_SECONDS,
  UNDER_ATTACK_BADGE_PUNCH_SCALE,
  UNDER_ATTACK_BADGE_PUNCH_SECONDS,
  UNDER_ATTACK_BADGE_SIZE,
  UNDER_ATTACK_BADGE_TEXTURE_SIZE,
  UNDER_ATTACK_BADGE_Y_OFFSET,
} from "./constants.ts";
import { warmObjectForRender, warmTextureForRender } from "./gpuWarmup.js";
import { makeNonInteractive } from "./sharedGeometry.js";
import {
  ALERT_PRIORITY,
  type AlertCategory,
} from "./underAttackAlertRules.ts";
import { boardState } from "./state.js";

/**
 * The visual under-attack cues, built the way `combatEffects.ts` builds its
 * bolts: module-level pools created once under the board root, WITHOUT
 * `ScenarioObject` so scenario reset never disposes them — reset just parks
 * them. Nothing here allocates per frame.
 *
 * All that lives here now is cue C: the threat badge — an eye, then crossed
 * swords, floating over a targeted unit's health bar.
 *
 * The command-center warning is the banner in `underAttackBanner.ts` plus the
 * alarm in `underAttackAudio.ts`. Three cues were built, shipped, Quest-tested
 * and then REMOVED at the user's request on 2026-08-17: the board shake, the
 * rim beacon, and the rim/ground flash. Their designs are recorded in
 * `RTSVR_repos/devlog/plan/2026-08-09-Under-Attack-Alerting-Plan.md`. Nothing
 * here should grow a board-position write, an edge marker, or a board material
 * tint again without re-reading why those went.
 */

interface BadgeSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  /** Entity index this badge is following, or -1 when free. */
  targetIndex: number;
  entity: Entity | null;
  phase: "idle" | "pop" | "idle-hold" | "out";
  age: number;
  /** Time since the last damage punch; >= punch duration means "not punching". */
  punchAge: number;
  /** "locked" = an alien is aiming; "attacking" = damage is landing right now. */
  mode: "locked" | "attacking";
  /** Seconds since the last hit, used to fall back from swords to the eye. */
  attackAge: number;
  /** Height of this unit's health bar, sampled once when the badge attaches. */
  barY: number;
}

interface ThreatEntry {
  entity: Entity;
  lastSeen: number;
  assigned: boolean;
}

const badgeSlots: BadgeSlot[] = [];
/** Keyed by entity index — deleted on death AND on reset (indexes recycle). */
const threatByIndex = new Map<number, ThreatEntry>();

let pooledRoot: Object3D | null = null;
let vfxWorld: World | null = null;
let lockedTexture: Texture | null = null;
let attackTexture: Texture | null = null;
let clock = 0;

// Scratch — reused every frame, never allocated in update().
const tmpWorld = new Vector3();
const tmpCamera = new Vector3();

/**
 * One canvas-drawn glyph per badge state, shared by all 12 planes. Built lazily
 * because `document` does not exist under `node --test`.
 */
function createBadgeTexture(glyph: string, ring: string): Texture | null {
  if (typeof document === "undefined") return null;
  const size = UNDER_ATTACK_BADGE_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, size, size);
  // A dark disc behind the glyph: ⚔️ falls back to a monochrome outline in
  // several fonts, which disappears against the bright Martian ground.
  context.beginPath();
  context.arc(size * 0.5, size * 0.5, size * 0.46, 0, Math.PI * 2);
  context.fillStyle = "rgba(20, 9, 10, 0.85)";
  context.fill();
  context.lineWidth = size * 0.045;
  context.strokeStyle = ring;
  context.stroke();
  context.font = `${Math.round(size * 0.56)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffe4e4";
  context.fillText(glyph, size * 0.5, size * 0.54);
  const texture = new Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function ensurePool(): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !vfxWorld) return false;
  if (pooledRoot === rootObject && badgeSlots.length > 0) return true;

  badgeSlots.length = 0;

  lockedTexture =
    lockedTexture ?? createBadgeTexture(UNDER_ATTACK_BADGE_LOCKED_GLYPH, "#f59e0b");
  attackTexture =
    attackTexture ?? createBadgeTexture(UNDER_ATTACK_BADGE_ATTACK_GLYPH, "#ef4444");
  const badgeGeometry = new PlaneGeometry(
    UNDER_ATTACK_BADGE_SIZE,
    UNDER_ATTACK_BADGE_SIZE,
  );
  for (let index = 0; index < UNDER_ATTACK_BADGE_POOL_SIZE; index += 1) {
    const material = new MeshBasicMaterial({
      map: lockedTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(badgeGeometry, material);
    makeNonInteractive(mesh);
    mesh.name = `UnderAttackBadge_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.drawCat = "vfx";
    vfxWorld.createTransformEntity(mesh, { parent: root });
    badgeSlots.push({
      mesh,
      material,
      targetIndex: -1,
      entity: null,
      phase: "idle",
      age: 0,
      punchAge: UNDER_ATTACK_BADGE_PUNCH_SECONDS,
      mode: "locked",
      attackAge: UNDER_ATTACK_BADGE_ATTACK_SECONDS,
      barY: 0,
    });
  }

  pooledRoot = rootObject;
  // Both badge states share the same shader variant (`map` is present), but
  // their canvas textures are distinct GPU uploads. Initialising them here
  // keeps a first alert from paying that upload in a combat frame.
  warmObjectForRender(badgeSlots[0]?.mesh, "under-attack-badge");
  warmTextureForRender(lockedTexture, "under-attack-badge:locked-texture");
  warmTextureForRender(attackTexture, "under-attack-badge:attack-texture");
  return true;
}

/**
 * Cue C's trigger. Called from the enemy loop in `CombatSystem` for whatever
 * each alien is targeting — the targeting work is already done there, so this
 * costs one map write and no scanning.
 */
export function markThreatened(target: Entity): boolean {
  const existing = threatByIndex.get(target.index);
  if (existing) {
    existing.entity = target;
    existing.lastSeen = clock;
    return false;
  }
  threatByIndex.set(target.index, {
    entity: target,
    lastSeen: clock,
    assigned: false,
  });
  // True only on the transition into "threatened" — the newly-spotted event.
  return true;
}

/**
 * Damage actually landed on this unit: swap the eye for crossed swords and
 * punch the scale. The badge falls back to the eye once the hits stop.
 */
export function punchThreatBadge(target: Entity): void {
  for (const slot of badgeSlots) {
    if (slot.targetIndex === target.index && slot.phase !== "idle") {
      slot.punchAge = 0;
      slot.attackAge = 0;
      setBadgeMode(slot, "attacking");
      return;
    }
  }
}

function setBadgeMode(slot: BadgeSlot, mode: BadgeSlot["mode"]): void {
  if (slot.mode === mode) return;
  slot.mode = mode;
  slot.material.map = mode === "attacking" ? attackTexture : lockedTexture;
  slot.material.needsUpdate = true;
}

/**
 * Entity indexes are pooled and reused, so a threat entry that outlives its
 * entity would silently re-point at whatever is created next. `CombatSystem`
 * calls this on every death; reset clears the rest.
 */
export function clearThreat(target: Entity): void {
  threatByIndex.delete(target.index);
  for (const slot of badgeSlots) {
    if (slot.targetIndex === target.index) releaseBadge(slot);
  }
}

function releaseBadge(slot: BadgeSlot): void {
  // Hand the threat back to the pool, or a still-threatened unit whose badge
  // was released would never be able to claim another slot.
  const entry = threatByIndex.get(slot.targetIndex);
  if (entry) entry.assigned = false;
  slot.phase = "out";
  slot.age = 0;
  slot.entity = null;
  slot.targetIndex = -1;
}

export function clearUnderAttackVfx(): void {
  for (const slot of badgeSlots) {
    slot.phase = "idle";
    slot.age = 0;
    slot.entity = null;
    slot.targetIndex = -1;
    slot.mesh.visible = false;
    slot.material.opacity = 0;
  }
  threatByIndex.clear();
}

export class UnderAttackVfxSystem extends createSystem({}) {
  init(): void {
    vfxWorld = this.world;
  }

  update(delta: number): void {
    const frameDelta = Math.max(0, delta);
    clock += frameDelta;
    if (!ensurePool()) return;
    // Board-local camera position, resolved once and shared by both billboards.
    const rootObject = boardState.boardRoot?.object3D ?? null;
    if (rootObject) {
      this.camera.getWorldPosition(tmpCamera);
      rootObject.worldToLocal(tmpCamera);
    }
    this.updateBadges(frameDelta, rootObject);
  }

  private updateBadges(delta: number, rootObject: Object3D | null): void {
    this.expireThreats();
    this.assignBadges();
    if (threatByIndex.size === 0 && !this.anyBadgeActive()) return;
    if (!rootObject) return;

    for (const slot of badgeSlots) {
      if (slot.phase === "idle") continue;
      slot.age += delta;
      slot.punchAge += delta;
      slot.attackAge += delta;
      if (
        slot.mode === "attacking" &&
        slot.attackAge >= UNDER_ATTACK_BADGE_ATTACK_SECONDS
      ) {
        setBadgeMode(slot, "locked");
      }

      if (slot.phase === "out") {
        const t = slot.age / UNDER_ATTACK_BADGE_OUT_SECONDS;
        if (t >= 1) {
          slot.phase = "idle";
          slot.mesh.visible = false;
          slot.material.opacity = 0;
          continue;
        }
        slot.material.opacity = 1 - t;
        slot.mesh.scale.setScalar(1 - 0.4 * t);
        continue;
      }

      const entity = slot.entity;
      const object = entity?.object3D;
      if (!entity || !object) {
        releaseBadge(slot);
        continue;
      }

      object.getWorldPosition(tmpWorld);
      rootObject.worldToLocal(tmpWorld);
      const bob =
        UNDER_ATTACK_BADGE_BOB *
        Math.sin(2 * Math.PI * UNDER_ATTACK_BADGE_BOB_HZ * clock);
      slot.mesh.position.set(
        tmpWorld.x,
        tmpWorld.y + slot.barY + UNDER_ATTACK_BADGE_Y_OFFSET + bob,
        tmpWorld.z,
      );
      slot.mesh.rotation.y = Math.atan2(
        tmpCamera.x - tmpWorld.x,
        tmpCamera.z - tmpWorld.z,
      );

      let scale = 1;
      if (slot.phase === "pop") {
        const t = slot.age / UNDER_ATTACK_BADGE_POP_SECONDS;
        if (t >= 1) {
          slot.phase = "idle-hold";
          slot.material.opacity = 1;
        } else {
          // 0 -> overshoot -> 1, so the badge lands with a little snap.
          scale =
            t < 0.6
              ? (UNDER_ATTACK_BADGE_POP_OVERSHOOT * t) / 0.6
              : UNDER_ATTACK_BADGE_POP_OVERSHOOT -
                (UNDER_ATTACK_BADGE_POP_OVERSHOOT - 1) * ((t - 0.6) / 0.4);
          slot.material.opacity = Math.min(1, t * 2);
        }
      } else {
        slot.material.opacity =
          0.9 + 0.1 * Math.sin(2 * Math.PI * UNDER_ATTACK_BADGE_BOB_HZ * clock);
      }

      if (slot.punchAge < UNDER_ATTACK_BADGE_PUNCH_SECONDS) {
        const t = slot.punchAge / UNDER_ATTACK_BADGE_PUNCH_SECONDS;
        scale *= UNDER_ATTACK_BADGE_PUNCH_SCALE - (UNDER_ATTACK_BADGE_PUNCH_SCALE - 1) * t;
      }
      slot.mesh.scale.setScalar(scale);
    }
  }

  private expireThreats(): void {
    for (const [index, entry] of threatByIndex) {
      if (clock - entry.lastSeen < UNDER_ATTACK_BADGE_LINGER_SECONDS) continue;
      threatByIndex.delete(index);
      for (const slot of badgeSlots) {
        if (slot.targetIndex === index) releaseBadge(slot);
      }
    }
  }

  private assignBadges(): void {
    for (const slot of badgeSlots) {
      if (slot.phase !== "idle") continue;
      const entry = this.nearestUnassignedThreat();
      if (!entry) return;
      const object = entry.entity.object3D;
      if (!object) {
        threatByIndex.delete(entry.entity.index);
        continue;
      }
      entry.assigned = true;
      slot.entity = entry.entity;
      slot.targetIndex = entry.entity.index;
      slot.phase = "pop";
      slot.age = 0;
      slot.punchAge = UNDER_ATTACK_BADGE_PUNCH_SECONDS;
      // A new badge always starts as "aimed at", never mid-fight.
      slot.attackAge = UNDER_ATTACK_BADGE_ATTACK_SECONDS;
      setBadgeMode(slot, "locked");
      // Sampled once on attach, not per frame — the bar never moves after that.
      slot.barY = object.getObjectByName("HealthBar")?.position.y ?? 0;
      slot.mesh.visible = true;
      slot.material.opacity = 0;
      slot.mesh.scale.setScalar(0);
    }
  }

  /**
   * With more threatened friendlies than badges, the ones nearest the command
   * center win the slots — that is where losing something actually costs the
   * player the match. One pass, no sort, no allocation.
   */
  private nearestUnassignedThreat(): ThreatEntry | null {
    const center = boardState.commandCenter?.object3D ?? null;
    let best: ThreatEntry | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of threatByIndex.values()) {
      if (entry.assigned) continue;
      const object = entry.entity.object3D;
      if (!object) continue;
      const distance = center
        ? object.position.distanceToSquared(center.position)
        : 0;
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
      if (!center) break;
    }
    return best;
  }

  private anyBadgeActive(): boolean {
    for (const slot of badgeSlots) {
      if (slot.phase !== "idle") return true;
    }
    return false;
  }

}
