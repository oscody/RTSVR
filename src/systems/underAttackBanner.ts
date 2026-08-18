import {
  PanelDocument,
  PanelUI,
  UIKit,
  UIKitDocument,
  Vector3,
  type Mesh,
  createSystem,
  type Entity,
  type Object3D,
} from "@iwsdk/core";
import {
  UNDER_ATTACK_BANNER_ABOVE_BAR,
  UNDER_ATTACK_BANNER_BACKGROUND_COLOR,
  UNDER_ATTACK_BANNER_BORDER_COLOR,
  UNDER_ATTACK_BANNER_BORDER_PULSE_COLOR,
  UNDER_ATTACK_BANNER_CAUTION_BACKGROUND_COLOR,
  UNDER_ATTACK_BANNER_CAUTION_BORDER_COLOR,
  UNDER_ATTACK_BANNER_CAUTION_ICON_BACKGROUND,
  UNDER_ATTACK_BANNER_CAUTION_PULSE_COLOR,
  UNDER_ATTACK_BANNER_ICON_BACKGROUND,
  UNDER_ATTACK_BANNER_HOLD_SECONDS,
  UNDER_ATTACK_BANNER_IN_SECONDS,
  UNDER_ATTACK_BANNER_MAX_HEIGHT,
  UNDER_ATTACK_BANNER_MAX_WIDTH,
  UNDER_ATTACK_BANNER_OUT_SECONDS,
  UNDER_ATTACK_BANNER_POSITION,
  UNDER_ATTACK_BANNER_PULSE_HZ,
  UNDER_ATTACK_BANNER_RENDER_ORDER,
  UNDER_ATTACK_BANNER_SLIDE,
} from "./constants.ts";
import { UnderAttackBanner, boardState } from "./state.js";

type UiElement = UIKit.Text & {
  setProperties(properties: Record<string, unknown>): void;
};

/**
 * Cue D's banner — the command-center warning, styled after a classic RTS
 * alert bar.
 *
 * Parented to the scene rather than the board root on purpose: cue A shakes the
 * board, and a shaking banner is an unreadable banner. It carries no
 * `RayInteractable` either, so it can never steal a selection ray.
 *
 * `setProperties` runs on phase transitions and on the ~1 Hz border pulse —
 * never a per-frame text rebuild.
 */

let visibleUntil = 0;
let phase: "idle" | "in" | "hold" | "out" = "idle";
let age = 0;
/** Resting height for this showing, sampled from the command center on raise. */
let baseY = UNDER_ATTACK_BANNER_POSITION[1];
let pendingTitle = "";
let pendingDetail = "";
let pendingShow = false;
let lastBorderPulseOn = false;
const liftedObjects = new WeakSet<Object3D>();
// Scratch, reused on each raise — never allocated per frame.
const bannerAnchor = new Vector3();
const cameraWorld = new Vector3();
const placedWorld = new Vector3();
// The last placement computed while the command center still existed.
const lastPlacedWorld = new Vector3();
let lastPlacedYaw = 0;
let hasLastPlacement = false;

/**
 * Draw the banner over everything instead of competing for space with the
 * scene. The tablet is parked beside the command center and occluded the
 * banner from ordinary viewing angles; nudging the position only moved the
 * problem, because the player can carry the tablet anywhere.
 *
 * Shared with the match-result panel, which sits in the same spot and would
 * otherwise be occluded by the tablet the same way.
 *
 * Depth testing is disabled and each node's EXISTING renderOrder is offset
 * rather than overwritten, so uikit's internal layering (text above panel
 * background) is preserved. Applied on each raise, not at creation, because
 * uikit builds the mesh tree lazily.
 */
export function liftAboveScene(object: Object3D): void {
  if (liftedObjects.has(object)) return;
  object.traverse((node) => {
    node.renderOrder += UNDER_ATTACK_BANNER_RENDER_ORDER;
    const material = (node as Mesh).material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      entry.depthTest = false;
    }
  });
  liftedObjects.add(object);
}

/** Red for real damage on the base, amber for a friendly merely being seen. */
export type BannerStyle = "critical" | "caution";

interface BannerPalette {
  border: string;
  pulse: string;
  background: string;
  iconBackground: string;
}

const BANNER_PALETTES: Readonly<Record<BannerStyle, BannerPalette>> = {
  critical: {
    border: UNDER_ATTACK_BANNER_BORDER_COLOR,
    pulse: UNDER_ATTACK_BANNER_BORDER_PULSE_COLOR,
    background: UNDER_ATTACK_BANNER_BACKGROUND_COLOR,
    iconBackground: UNDER_ATTACK_BANNER_ICON_BACKGROUND,
  },
  caution: {
    border: UNDER_ATTACK_BANNER_CAUTION_BORDER_COLOR,
    pulse: UNDER_ATTACK_BANNER_CAUTION_PULSE_COLOR,
    background: UNDER_ATTACK_BANNER_CAUTION_BACKGROUND_COLOR,
    iconBackground: UNDER_ATTACK_BANNER_CAUTION_ICON_BACKGROUND,
  },
};

let pendingStyle: BannerStyle = "critical";
let activePalette: BannerPalette = BANNER_PALETTES.critical;

/** Raise (or refresh) the banner. One panel, restyled per alert kind. */
export function showUnderAttackBanner(
  title: string,
  detail: string,
  style: BannerStyle = "critical",
): void {
  pendingTitle = title;
  pendingDetail = detail;
  pendingStyle = style;
  pendingShow = true;
}

export function hideUnderAttackBanner(): void {
  pendingShow = false;
  if (phase === "idle" || phase === "out") return;
  phase = "out";
  age = 0;
}

export function clearUnderAttackBanner(): void {
  pendingShow = false;
  phase = "idle";
  age = 0;
  visibleUntil = 0;
  // Forget the remembered anchor: the next match rebuilds the command center,
  // and a stale placement would outlive the base it was measured from.
  hasLastPlacement = false;
  const panel = boardState.underAttackBanner;
  if (panel?.object3D) panel.object3D.visible = false;
  panel?.setValue(UnderAttackBanner, "visible", false);
}

/**
 * Shared command-center alert placement. The alert panel is scene-parented, but
 * the match-result panel is board-parented, so compute the desired world point
 * first and then convert it through whatever parent the target object has.
 */
export function placeAtCommandCenterAlertPosition(
  object: Object3D,
  camera: Object3D,
): number {
  const holder = boardState.commandCenter?.object3D ?? null;
  if (!holder) {
    // Defeat usually MEANS the command center was destroyed (`combat.ts` nulls
    // it out), so the match-result panel asks for a position after the anchor
    // is gone. Reuse the last placement computed while it existed, so the
    // result panel appears exactly where the alerts have been all match. The
    // fixed constant is a last resort for "there was never a command center".
    if (hasLastPlacement) {
      placedWorld.copy(lastPlacedWorld);
      object.parent?.worldToLocal(placedWorld);
      object.position.copy(placedWorld);
      object.rotation.set(0, lastPlacedYaw, 0);
      return object.position.y;
    }
    placedWorld.set(...UNDER_ATTACK_BANNER_POSITION);
    object.parent?.worldToLocal(placedWorld);
    object.position.copy(placedWorld);
    return object.position.y;
  }

  holder.getWorldPosition(bannerAnchor);
  const barY = holder.getObjectByName("HealthBar")?.position.y ?? 0;
  const baseWorldY = bannerAnchor.y + barY + UNDER_ATTACK_BANNER_ABOVE_BAR;

  // Directly over the base: same x/z as the command center, so the health bar,
  // threat badge, HUD strip and this panel share one vertical line. Only the
  // facing tracks the player.
  camera.getWorldPosition(cameraWorld);
  const toViewerX = cameraWorld.x - bannerAnchor.x;
  const toViewerZ = cameraWorld.z - bannerAnchor.z;
  placedWorld.set(bannerAnchor.x, baseWorldY, bannerAnchor.z);

  const yaw = Math.atan2(toViewerX, toViewerZ);
  // Remember it in WORLD space, before the conversion below mutates it — the
  // two callers live in different parent spaces.
  lastPlacedWorld.copy(placedWorld);
  lastPlacedYaw = yaw;
  hasLastPlacement = true;

  object.parent?.worldToLocal(placedWorld);
  object.position.copy(placedWorld);
  // Yaw-only turn toward the viewer: a panel facing away is not useful.
  object.rotation.set(0, yaw, 0);
  return object.position.y;
}

export class UnderAttackBannerSystem extends createSystem({
  panels: { required: [UnderAttackBanner, PanelUI, PanelDocument] },
}) {
  private panel: Entity | null = null;
  private document: UIKitDocument | null = null;

  init(): void {
    this.createPanel();
    this.cleanupFuncs.push(
      this.queries.panels.subscribe("qualify", (entity) => {
        this.panel = entity;
        this.document = PanelDocument.data.document[
          entity.index
        ] as UIKitDocument;
      }),
    );
  }

  update(delta: number): void {
    const panel = this.panel ?? boardState.underAttackBanner;
    const object = panel?.object3D;
    if (!panel || !object) return;

    if (pendingShow) {
      pendingShow = false;
      this.present();
      this.placeOverCommandCenter(object);
      phase = "in";
      age = 0;
      visibleUntil = 0;
      object.visible = true;
      panel.setValue(UnderAttackBanner, "visible", true);
    }
    if (phase === "idle") return;

    const frameDelta = Math.max(0, delta);
    age += frameDelta;

    if (phase === "in") {
      const t = Math.min(1, age / UNDER_ATTACK_BANNER_IN_SECONDS);
      object.position.y = baseY + UNDER_ATTACK_BANNER_SLIDE * (1 - t);
      if (t >= 1) {
        phase = "hold";
        age = 0;
        visibleUntil = UNDER_ATTACK_BANNER_HOLD_SECONDS;
      }
      return;
    }

    if (phase === "hold") {
      object.position.y = baseY;
      // One property, ~1 Hz — written only when the pulse actually flips.
      const on =
        Math.sin(2 * Math.PI * UNDER_ATTACK_BANNER_PULSE_HZ * age) >= 0;
      if (on !== lastBorderPulseOn) {
        lastBorderPulseOn = on;
        this.element("alert-banner")?.setProperties({
          borderColor: on ? activePalette.border : activePalette.pulse,
        });
      }
      if (age >= visibleUntil) {
        phase = "out";
        age = 0;
      }
      return;
    }

    const t = Math.min(1, age / UNDER_ATTACK_BANNER_OUT_SECONDS);
    object.position.y = baseY - UNDER_ATTACK_BANNER_SLIDE * t;
    if (t < 1) return;
    phase = "idle";
    object.visible = false;
    object.position.y = baseY;
    panel.setValue(UnderAttackBanner, "visible", false);
  }

  /**
   * Park the banner directly above the command center's health bar and turn it
   * to face the player.
   *
   * Sampled once per showing rather than every frame: the board shakes under
   * cue A, and a banner that tracked it would shake with it. The command center
   * never moves, so one sample is enough.
   */
  private placeOverCommandCenter(object: Object3D): void {
    baseY = placeAtCommandCenterAlertPosition(object, this.camera);
    liftAboveScene(object);
  }

  private present(): void {
    const palette = BANNER_PALETTES[pendingStyle];
    // Upper-case in the banner only — the alert state keeps sentence case so
    // any later consumer (a tablet log) is not stuck shouting.
    this.element("alert-title")?.setProperties({
      text: pendingTitle.toUpperCase(),
      color: palette.border,
    });
    this.element("alert-detail")?.setProperties({ text: pendingDetail });
    this.element("alert-banner")?.setProperties({
      borderColor: palette.border,
      backgroundColor: palette.background,
    });
    this.element("alert-icon-box")?.setProperties({
      borderColor: palette.border,
      backgroundColor: palette.iconBackground,
    });
    this.element("alert-icon")?.setProperties({ color: palette.border });
    activePalette = palette;
    lastBorderPulseOn = true;
  }

  private element(id: string): UiElement | null {
    return this.document?.getElementById(id) as UiElement | null;
  }

  private createPanel(): void {
    const panel = this.world
      .createTransformEntity(undefined, { persistent: true })
      .addComponent(PanelUI, {
        config: "./ui/command-center-alert.json",
        maxWidth: UNDER_ATTACK_BANNER_MAX_WIDTH,
        maxHeight: UNDER_ATTACK_BANNER_MAX_HEIGHT,
      })
      .addComponent(UnderAttackBanner);
    panel.object3D!.name = "UnderAttackBannerPanel";
    panel.object3D!.position.set(
      UNDER_ATTACK_BANNER_POSITION[0],
      UNDER_ATTACK_BANNER_POSITION[1],
      UNDER_ATTACK_BANNER_POSITION[2],
    );
    panel.object3D!.visible = false;
    boardState.underAttackBanner = panel;
  }
}
