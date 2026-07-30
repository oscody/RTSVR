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
} from "./constants.ts";

// The space backdrop: a near-black DomeGradient sky, a procedural starfield, and
// a warm directional "sun". Independent of the board — the sun/stars are
// persistent entities and the dome lives on the level root.
export class SkySystem extends createSystem({}) {
  // `defaultLighting: true` installs a default (light-blue) DomeGradient on the
  // level root AFTER init() runs, so setting our colors in init gets clobbered.
  // Instead re-apply for the first several frames from update() (below), which
  // run after the framework's one-time setup has settled.
  private skyFramesLeft = 12;

  init(): void {
    // A dark fallback background + a persistent warm sun (survives resets).
    this.world.scene.background = new Color(SKY_FALLBACK_COLOR);
    const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    sun.name = "Sun";
    sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
    this.world.createTransformEntity(sun, { persistent: true });
    this.createStarfield();
  }

  update(): void {
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
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const stars = new Points(
      geometry,
      new PointsMaterial({
        color: STARFIELD_COLOR,
        size: STARFIELD_SIZE,
        sizeAttenuation: false,
        toneMapped: false,
        depthWrite: false,
      }),
    );
    stars.name = "Starfield";
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    this.world.createTransformEntity(stars, { persistent: true });
  }
}
