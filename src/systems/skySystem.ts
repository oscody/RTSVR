import {
  BufferGeometry,
  Color,
  DirectionalLight,
  DomeGradient,
  Entity,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  createSystem,
} from "@iwsdk/core";
import { trackResource, tracked } from "./resourceLifetime.js";
import {
  SKY_DOME_EQUATOR,
  SKY_DOME_GROUND,
  SKY_DOME_INTENSITY,
  SKY_DOME_SKY,
  SKY_FALLBACK_COLOR,
  STARFIELD_COLOR,
  STARFIELD_COUNT,
  STARFIELD_RADIUS,
  STARFIELD_SIZE,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_POSITION,
  TUTORIAL_DIM_RAMP_SECONDS,
} from "./constants.ts";

// The space backdrop: a near-black DomeGradient sky, a procedural starfield, and
// a warm directional "sun". Independent of the board — the sun/stars are
// persistent entities and the dome lives on the level root.
/**
 * How dim the world should be, 1 = normal. Written by the tutorial, eased
 * toward by SkySystem.
 *
 * A module-level target rather than a component: one system owns the lighting,
 * one system writes it, and nothing else needs to see it. Same shape as the
 * tutorial's tab hint.
 */
let dimTarget = 1;

/**
 * Dim (or restore) the world. `1` is normal; anything less darkens the sun and
 * the dome together.
 *
 * Note the sky is ALREADY near-black (`SKY_DOME_SKY` is 0.006), so dimming the
 * dome alone would be invisible — what actually lights the board is the
 * directional sun, and that is the term that matters here.
 *
 * **Whoever dims must restore.** Every caller path — drill advance, dormancy,
 * reset, the tutorial being switched off — has to come back to 1, or the match
 * is left dark with nothing to explain why.
 */
export function setEnvironmentDim(target: number): void {
  dimTarget = Math.max(0, Math.min(1, target));
}

export class SkySystem extends createSystem({}) {
  // `defaultLighting: true` installs a default (light-blue) DomeGradient on the
  // level root AFTER init() runs, so setting our colors in init gets clobbered.
  // Instead re-apply for the first several frames from update() (below), which
  // run after the framework's one-time setup has settled.
  private skyFramesLeft = 12;
  private sun: DirectionalLight | null = null;
  /** Current eased dim, chasing `dimTarget`. */
  private dim = 1;

  init(): void {
    // A dark fallback background + a persistent warm sun (survives resets).
    this.world.scene.background = new Color(SKY_FALLBACK_COLOR);
    const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun = sun;
    sun.name = "Sun";
    sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
    this.world.createTransformEntity(sun, { persistent: true });
    this.createStarfield();
  }

  update(delta: number): void {
    this.applyDim(delta);
    if (this.skyFramesLeft <= 0) return;
    const levelRoot = this.world.activeLevel?.value;
    if (!levelRoot?.hasComponent(DomeGradient)) return;
    // Color (RGBA vector) fields MUST be written through getVectorView, not
    // setValue (which throws for array/vector types). Scalars use setValue.
    this.writeDomeColor(levelRoot, "sky", SKY_DOME_SKY);
    this.writeDomeColor(levelRoot, "equator", SKY_DOME_EQUATOR);
    this.writeDomeColor(levelRoot, "ground", SKY_DOME_GROUND);
    levelRoot.setValue(DomeGradient, "intensity", SKY_DOME_INTENSITY);
    levelRoot.setValue(DomeGradient, "_needsUpdate", true);
    this.skyFramesLeft -= 1;
  }

  /**
   * Ease the current dim toward the target and push it to the sun and dome.
   *
   * Costs nothing once settled — the early return is the common case, since the
   * dim only moves during the ~0.6 s ramps at either end of a tutorial beat.
   */
  private applyDim(delta: number): void {
    if (this.dim === dimTarget) return;
    const step = Math.max(0, delta) / Math.max(0.001, TUTORIAL_DIM_RAMP_SECONDS);
    if (Math.abs(dimTarget - this.dim) <= step) this.dim = dimTarget;
    else this.dim += Math.sign(dimTarget - this.dim) * step;

    if (this.sun) this.sun.intensity = SUN_INTENSITY * this.dim;
    const levelRoot = this.world.activeLevel?.value;
    if (levelRoot?.hasComponent(DomeGradient)) {
      levelRoot.setValue(DomeGradient, "intensity", SKY_DOME_INTENSITY * this.dim);
      levelRoot.setValue(DomeGradient, "_needsUpdate", true);
    }
    // The sky-colour block above re-asserts full intensity for its first 12
    // frames; let it finish before the dim starts fighting it.
    if (this.skyFramesLeft > 0) this.skyFramesLeft = 0;
  }

  private writeDomeColor(
    levelRoot: Entity,
    field: "sky" | "equator" | "ground",
    rgba: readonly [number, number, number, number],
  ): void {
    const view = levelRoot.getVectorView(DomeGradient, field) as Float32Array;
    view[0] = rgba[0];
    view[1] = rgba[1];
    view[2] = rgba[2];
    view[3] = rgba[3];
  }

  // A cloud of points on a large sphere = a cheap one-draw-call starfield.
  private createStarfield(): void {
    const positions = new Float32Array(STARFIELD_COUNT * 3);
    for (let i = 0; i < STARFIELD_COUNT; i += 1) {
      const u = Math.random() * 2 - 1;
      const angle = Math.random() * Math.PI * 2;
      const ring = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(angle) * ring * STARFIELD_RADIUS;
      positions[i * 3 + 1] = u * STARFIELD_RADIUS;
      positions[i * 3 + 2] = Math.sin(angle) * ring * STARFIELD_RADIUS;
    }
    const geometry = new BufferGeometry();
    // The starfield: one geometry and one material for the whole session.
    trackResource(geometry, {
      kind: "geometry",
      scope: "session",
      label: "starfield",
    });
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const stars = new Points(
      geometry,
      tracked(new PointsMaterial({
        color: STARFIELD_COLOR,
        size: STARFIELD_SIZE,
        sizeAttenuation: false,
        toneMapped: false,
        depthWrite: false,
      }), "material", "session", "starfield"),
    );
    stars.name = "Starfield";
    stars.userData.drawCat = "sky"; // draw-call profiler category
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    this.world.createTransformEntity(stars, { persistent: true });
  }
}

