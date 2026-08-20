import {
  Box3,
  Color,
  PointLight,
  Vector3,
  type Mesh,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  TUTORIAL_SPOTLIGHT_BOOST,
  TUTORIAL_SPOTLIGHT_LIGHT_COLOR,
  TUTORIAL_SPOTLIGHT_LIGHT_DISTANCE,
  TUTORIAL_SPOTLIGHT_LIGHT_HEIGHT,
  TUTORIAL_SPOTLIGHT_LIGHT_INTENSITY,
  TUTORIAL_RING_RADIUS,
  TUTORIAL_RING_SUBJECT_MARGIN,
} from "./constants.ts";

/**
 * Lights ONE subject up while the rest of the world is dimmed.
 *
 * **Subject-agnostic on purpose.** It takes an `Object3D`, so the same effect
 * works for the command center, a unit, an alien or a building — which is what
 * makes "introduce a new thing" a data change in `TUTORIAL_DRILLS` rather than
 * new code each time.
 *
 * The dim alone was only half the concept art: it darkened everything
 * *including* the thing the player is being told to look at. This is the other
 * half — the subject stays lit while its surroundings fall away.
 *
 * **Self-illumination, not a light.** Adding a spotlight would mean a new light
 * in the scene, a possible shader recompile, and a light budget to worry about
 * on Quest. Raising `emissive` on the base's own materials is a uniform write,
 * costs nothing, and cannot be occluded or fall off at the wrong angle.
 *
 * The emissive colour is derived from each material's own `color`, so the
 * building glows in its own hues rather than washing to white.
 */

interface HighlightSlot {
  material: { emissive?: Color; emissiveIntensity?: number; color?: Color };
  /** Authored values, restored exactly when the highlight lifts. */
  emissive: Color;
  intensity: number;
  color: Color | null;
}

/**
 * The beat's own light, following the command center.
 *
 * Created at init with intensity 0 and never removed. That is deliberate:
 * adding a light to a scene changes the shader program for every material that
 * receives it, so a light that appears mid-beat would recompile shaders at the
 * worst possible moment. Present-but-dark from startup pays that cost once, at
 * load, and the beat then only writes a uniform.
 *
 * Needed because the dim is now deep enough to match the concept art — at ~1%
 * sun there is no light left for a colour scale to work with, and the base
 * measured 29 against a normal 71. Scaling colours alone cannot light a model
 * in the dark.
 */
let spotlight: PointLight | null = null;
const tmpLightPos = new Vector3();
const tmpBounds = new Box3();
const tmpSize = new Vector3();

const slots: HighlightSlot[] = [];
/** The holder the slots were captured from; a reset rebuilds the base. */
let capturedHolder: Object3D | null = null;
let applied = -1;


/** Called once from TutorialSystem.init, before any beat can run. */
export function attachTutorialSpotlight(world: World): void {
  if (spotlight) return;
  spotlight = new PointLight(
    TUTORIAL_SPOTLIGHT_LIGHT_COLOR,
    0,
    TUTORIAL_SPOTLIGHT_LIGHT_DISTANCE,
  );
  spotlight.name = "TutorialSpotlight";
  world.createTransformEntity(spotlight, { persistent: true });
}

function capture(holder: Object3D): void {
  slots.length = 0;
  holder.traverse((node) => {
    const material = (node as Mesh).material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const target = entry as HighlightSlot["material"];
      // Unlit materials (MeshBasicMaterial) have no emissive and are already
      // immune to the dim, so there is nothing to do for them either way.
      if (!target.emissive && !target.color) continue;
      slots.push({
        material: target,
        emissive: target.emissive?.clone() ?? new Color(),
        intensity: target.emissiveIntensity ?? 1,
        color: target.color?.clone() ?? null,
      });
    }
  });
  capturedHolder = holder;
  applied = -1;
  // A silent no-op is the failure mode here: if the model's materials turn out
  // to be unlit, the highlight does nothing and looks like a tuning problem.
  if (slots.length === 0) {
    console.warn(
      "[Tutorial] command-center highlight found no lit materials; the model is unlit and cannot be brightened by emissive",
    );
  }
}

/**
 * `0` restores the authored look; `1` is full highlight.
 *
 * Idempotent, so it is safe to call every frame. **Whoever highlights must
 * restore** — the same discipline the dim needs, and for the same reason: a base
 * left glowing after the beat is a bug nobody can explain.
 */
export function setSpotlightSubject(
  subject: Object3D | null,
  position: Vector3 | null,
  factor: number,
): void {
  const holder = subject;
  if (!holder) {
    // No object to brighten — but a tile target still gets the light, so the
    // player can see WHERE they are being sent even on bare ground.
    if (spotlight) {
      if (position) {
        spotlight.position.set(
          position.x,
          position.y + TUTORIAL_SPOTLIGHT_LIGHT_HEIGHT,
          position.z,
        );
        spotlight.intensity =
          TUTORIAL_SPOTLIGHT_LIGHT_INTENSITY *
          Math.max(0, Math.min(1, factor));
      } else {
        spotlight.intensity = 0;
      }
    }
    restoreSlots();
    return;
  }
  // A different subject (or a rebuilt one) means new materials to capture; the
  // previous subject must be put back first or it stays lit forever.
  if (holder !== capturedHolder) {
    restoreSlots();
    capture(holder);
  }

  const clamped = Math.max(0, Math.min(1, factor));
  // The light follows the subject every call — subjects move, and the base can
  // be rebuilt. The material work below is guarded on change.
  if (spotlight) {
    holder.getWorldPosition(tmpLightPos);
    spotlight.position.set(
      tmpLightPos.x,
      tmpLightPos.y + TUTORIAL_SPOTLIGHT_LIGHT_HEIGHT,
      tmpLightPos.z,
    );
    spotlight.intensity = TUTORIAL_SPOTLIGHT_LIGHT_INTENSITY * clamped;
  }
  if (clamped === applied) return;
  applied = clamped;

  for (const slot of slots) {
    if (clamped <= 0) {
      if (slot.material.emissive) slot.material.emissive.copy(slot.emissive);
      slot.material.emissiveIntensity = slot.intensity;
      if (slot.color) slot.material.color!.copy(slot.color);
      continue;
    }
    // Scale the base COLOUR up, which is the mechanism `setBoardDim` already
    // proves works on this content. Three.js colours are floats and may exceed
    // 1, so this has the headroom to out-run the dim.
    //
    // Emissive was tried first and moved the measured brightness by ~1 point
    // (63 -> 65): whatever these materials are, emissive is not reaching the
    // renderer for them. Emissive is still written as a bonus for any material
    // that does honour it, but the colour scale is what carries the effect.
    if (slot.color) {
      slot.material.color!.copy(slot.color).multiplyScalar(
        1 + (TUTORIAL_SPOTLIGHT_BOOST - 1) * clamped,
      );
    }
    if (slot.material.emissive && slot.color) {
      slot.material.emissive.copy(slot.color).multiplyScalar(0.35 * clamped);
    }
  }
}

/** Put every captured material back exactly as authored. */
function restoreSlots(): void {
  if (applied <= 0) return;
  for (const slot of slots) {
    if (slot.material.emissive) slot.material.emissive.copy(slot.emissive);
    slot.material.emissiveIntensity = slot.intensity;
    if (slot.color) slot.material.color!.copy(slot.color);
  }
  applied = 0;
}

/**
 * A ring radius that fits the subject.
 *
 * Measured from the object's own bounds rather than configured per drill: a
 * 3-tile command center and a 1-tile alien need very different rings, and
 * deriving it means adding a new subject needs no new tuning. Falls back to the
 * default radius when there is nothing to measure (tile targets).
 */
export function subjectRingRadius(subject: Object3D | null): number {
  if (!subject) return TUTORIAL_RING_RADIUS;
  tmpBounds.setFromObject(subject);
  tmpSize.set(0, 0, 0);
  tmpBounds.getSize(tmpSize);
  const footprint = Math.max(tmpSize.x, tmpSize.z) / 2;
  if (!Number.isFinite(footprint) || footprint <= 0) return TUTORIAL_RING_RADIUS;
  // Must CLEAR the subject — a ring drawn inside the thing it surrounds reads
  // as a bug, which is exactly what happened with the command center's skirt.
  return footprint + TUTORIAL_RING_SUBJECT_MARGIN;
}

/** Scenario reset: forget the old model's materials. */
export function clearSpotlightSubject(): void {
  restoreSlots();
  if (spotlight) spotlight.intensity = 0;
  slots.length = 0;
  capturedHolder = null;
  applied = -1;
}
