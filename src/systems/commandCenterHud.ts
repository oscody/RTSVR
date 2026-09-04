import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  createSystem,
  type Object3D,
} from "@iwsdk/core";
import {
  COMMAND_CENTER_HUD_BACKGROUND,
  COMMAND_CENTER_HUD_BORDER,
  COMMAND_CENTER_HUD_GEM_COLOR,
  COMMAND_CENTER_HUD_HEIGHT,
  COMMAND_CENTER_HUD_LABEL_COLOR,
  COMMAND_CENTER_HUD_TEXTURE_HEIGHT,
  COMMAND_CENTER_HUD_TEXTURE_WIDTH,
  COMMAND_CENTER_HUD_TROOPS_HIGH_COLOR,
  COMMAND_CENTER_HUD_TROOPS_LOW_COLOR,
  COMMAND_CENTER_HUD_TROOPS_LOW_RATIO,
  COMMAND_CENTER_HUD_VALUE_COLOR,
  COMMAND_CENTER_HUD_WIDTH,
  COMMAND_CENTER_HUD_Y_OFFSET,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import {
  Enemy,
  GameState,
  Health,
  WaveSource,
  boardState,
} from "./state.js";
import { TUTORIAL_WAVE_NUMBER, waveTotalEnemyCount } from "./waveCatalog.js";
import { trackResource, tracked } from "./resourceLifetime.js";

/**
 * The always-on readout over the command center: which level you are on, how
 * many of that level's troops are still standing, and your crystal balance.
 *
 * It slots into the stack over the base, which reads bottom-to-top as
 * health bar -> threat badge -> this -> under-attack banner.
 *
 * Built the way `queueBadge.ts` draws its numbers — one plane, one
 * `CanvasTexture` — rather than as a second `PanelUI`. The tablet's `PanelUI`
 * is already the frame's most expensive UI work, and this thing is on screen
 * for the entire match. The canvas is redrawn only when one of the three
 * numbers actually changes, so a steady state costs a transform update.
 *
 * The mesh lives under the board root, NOT under the command center, so it
 * survives the command center being destroyed and rebuilt by scenario reset —
 * the same reason the combat-effect pools sit there.
 */

let hudMesh: Mesh | null = null;
let hudMaterial: MeshBasicMaterial | null = null;
let hudTexture: CanvasTexture | null = null;
let hudContext: CanvasRenderingContext2D | null = null;
let pooledRoot: Object3D | null = null;

// Last rendered values. Numbers, not a string, so the common case compares
// three integers instead of building and comparing text every frame.
let lastLevel = -1;
let lastRemaining = -1;
let lastTotal = -1;
let lastCrystals = -1;

const tmpAnchor = new Vector3();
const tmpCamera = new Vector3();

function ensureHud(world: {
  createTransformEntity: (object: Object3D, options: { parent: unknown }) => unknown;
}): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject) return false;
  if (pooledRoot === rootObject && hudMesh) return true;
  if (typeof document === "undefined") return false;

  const canvas = document.createElement("canvas");
  canvas.width = COMMAND_CENTER_HUD_TEXTURE_WIDTH;
  canvas.height = COMMAND_CENTER_HUD_TEXTURE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return false;
  hudContext = context;

  hudTexture = new CanvasTexture(canvas);
  // One per session: the HUD strip redraws into the same canvas rather than
  // making a new texture, so this must stay at exactly 1 across every cycle.
  trackResource(hudTexture, {
    kind: "texture",
    scope: "session",
    label: "command-center-hud",
  });
  hudTexture.anisotropy = 4;
  hudMaterial = tracked(new MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  }), "material", "session", "command-center-hud");
  hudMesh = new Mesh(
    tracked(
      new PlaneGeometry(COMMAND_CENTER_HUD_WIDTH, COMMAND_CENTER_HUD_HEIGHT),
      "geometry",
      "session",
      "command-center-hud",
    ),
    hudMaterial,
  );
  makeNonInteractive(hudMesh);
  hudMesh.name = "CommandCenterHud";
  hudMesh.visible = false;
  hudMesh.frustumCulled = false;
  hudMesh.userData.drawCat = "hud";
  world.createTransformEntity(hudMesh, { parent: root });
  pooledRoot = rootObject;
  // Force a redraw: a rebuilt canvas starts blank.
  lastLevel = -1;
  return true;
}

/** Spacer between the three readouts. A string so it measures like the rest. */
const GAP = "   ";
/** Fraction of the texture width kept clear at each end. */
const COMMAND_CENTER_HUD_PAD_RATIO = 0.045;

function fontFor(isLabel: boolean, height: number, scale: number): string {
  const size = Math.round(height * (isLabel ? 0.3 : 0.42) * scale);
  return isLabel ? `600 ${size}px sans-serif` : `bold ${size}px sans-serif`;
}

/** Redraw the strip. Called only when one of the three numbers has changed. */
function paint(
  level: number,
  remaining: number,
  total: number,
  crystals: number,
): void {
  const context = hudContext;
  if (!context || !hudTexture) return;
  const width = COMMAND_CENTER_HUD_TEXTURE_WIDTH;
  const height = COMMAND_CENTER_HUD_TEXTURE_HEIGHT;
  context.clearRect(0, 0, width, height);

  const radius = height * 0.28;
  context.beginPath();
  context.roundRect(2, 2, width - 4, height - 4, radius);
  context.fillStyle = COMMAND_CENTER_HUD_BACKGROUND;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = COMMAND_CENTER_HUD_BORDER;
  context.stroke();

  const midY = height * 0.54;
  context.textBaseline = "middle";
  context.textAlign = "left";

  // Build the line as segments first, then fit it — rather than drawing
  // left-to-right from a fixed pad and hoping it lands inside the pill.
  //
  // It did not. "LEVEL TUTORIAL" is several times wider than "LEVEL 1", so the
  // gem count ran off the right edge of the texture for the whole tutorial.
  // Measuring first makes the strip content-independent, which also covers the
  // cases still ahead of it: TROOPS 100/100, and a five-digit gem count.
  const ratio = total > 0 ? remaining / total : 0;
  const label = COMMAND_CENTER_HUD_LABEL_COLOR;
  const segments: { text: string; label: boolean; color: string }[] = [
    { text: "LEVEL ", label: true, color: label },
    // Wave 0 is the tutorial's own level. "LEVEL 0" reads as a bug; the word
    // says what is actually happening, and its disappearance is the reward for
    // clearing it.
    {
      text: level === TUTORIAL_WAVE_NUMBER ? "TUTORIAL" : String(level),
      label: false,
      color: COMMAND_CENTER_HUD_VALUE_COLOR,
    },
    { text: GAP, label: true, color: label },
    { text: "TROOPS ", label: true, color: label },
    // Remaining AND the level's total. The count alone was ambiguous — "11"
    // answers neither "how many are left" nor "out of how many", and colour is
    // too weak a channel to carry that on its own. The total is dimmed so the
    // number that changes is the one that reads first.
    {
      text: String(remaining),
      label: false,
      color:
        ratio <= COMMAND_CENTER_HUD_TROOPS_LOW_RATIO
          ? COMMAND_CENTER_HUD_TROOPS_LOW_COLOR
          : COMMAND_CENTER_HUD_TROOPS_HIGH_COLOR,
    },
    { text: `/${total}`, label: true, color: label },
    { text: GAP, label: true, color: label },
    { text: "GEMS ", label: true, color: label },
    {
      text: String(crystals),
      label: false,
      color: COMMAND_CENTER_HUD_GEM_COLOR,
    },
  ];

  const measure = (scale: number): number => {
    let total = 0;
    for (const segment of segments) {
      context.font = fontFor(segment.label, height, scale);
      total += context.measureText(segment.text).width;
    }
    return total;
  };

  const available = width * (1 - COMMAND_CENTER_HUD_PAD_RATIO * 2);
  const natural = measure(1);
  // Text width is linear in font size for a fixed string, so one pass lands it.
  const scale = natural > available ? available / natural : 1;
  const finalWidth = scale < 1 ? measure(scale) : natural;

  // Centred, not left-anchored: the pill is a fixed size and the content is
  // not, so anchoring left leaves a lopsided gap whenever the line is short.
  let x = (width - finalWidth) / 2;
  for (const segment of segments) {
    context.font = fontFor(segment.label, height, scale);
    context.fillStyle = segment.color;
    context.fillText(segment.text, x, midY);
    x += context.measureText(segment.text).width;
  }

  hudTexture.needsUpdate = true;
}

/**
 * World-space Y of the top edge of the LEVEL/TROOPS/GEMS strip, or null when it
 * is not up.
 *
 * Exported so the tutorial arrow can sit above the strip rather than at the
 * command center's origin — which is the building's FOOT, so a marker placed
 * there with only a tip gap ends up inside a three-tile-tall building.
 *
 * Reading the strip's actual position rather than re-deriving the offsets keeps
 * one source of truth for the stack over the base: move the strip and the arrow
 * follows it.
 */
export function commandCenterHudTopWorldY(): number | null {
  if (!hudMesh?.visible) return null;
  hudMesh.getWorldPosition(tmpAnchor);
  return tmpAnchor.y + COMMAND_CENTER_HUD_HEIGHT / 2;
}

export function clearCommandCenterHud(): void {
  if (hudMesh) hudMesh.visible = false;
  // Wave totals and crystals both reset with the scenario; force a repaint so
  // the first frame of the new match cannot show the old numbers.
  lastLevel = -1;
  lastRemaining = -1;
  lastTotal = -1;
  lastCrystals = -1;
}

export class CommandCenterHudSystem extends createSystem({
  enemies: { required: [Enemy, Health] },
}) {
  update(): void {
    if (!ensureHud(this.world as never)) return;
    const mesh = hudMesh;
    const holder = boardState.commandCenter?.object3D ?? null;
    const rootObject = boardState.boardRoot?.object3D ?? null;
    if (!mesh || !holder || !rootObject) {
      if (mesh) mesh.visible = false;
      return;
    }

    const source = boardState.waveSource;
    const level = source?.getValue(WaveSource, "waveNumber") ?? 1;
    const total = waveTotalEnemyCount(level);
    // Every alive enemy of this wave, RESERVES INCLUDED — deliberately not the
    // same rule as the tablet's "Enemies alive", which counts only what is on
    // the board.
    //
    // They measure different things and the labels say so. This strip answers
    // "how much of this wave is left", so it counts down 11/11, 10/11, 9/11 and
    // reaches 0 when the wave is beaten. The tablet answers "what am I fighting
    // right now". Narrowing this one to released-only was tried on 2026-08-19
    // and reverted by the owner: it turned the wave counter into a duplicate of
    // a number the player can already see by looking at the board, and threw
    // away the only readout of progress through a wave.
    //
    // The cost is that during the tutorial's Act 1 it reads TROOPS 3/3 with an
    // empty board. That is true of the wave and false of the board; the tablet
    // is where you look for the board.
    let remaining = 0;
    for (const enemy of this.queries.enemies.entities) {
      if ((enemy.getValue(Health, "current") ?? 0) > 0) remaining += 1;
    }
    const crystals =
      boardState.gameState?.getValue(GameState, "crystals") ?? 0;

    if (
      level !== lastLevel ||
      remaining !== lastRemaining ||
      total !== lastTotal ||
      crystals !== lastCrystals
    ) {
      lastLevel = level;
      lastRemaining = remaining;
      lastTotal = total;
      lastCrystals = crystals;
      paint(level, remaining, total, crystals);
    }

    // Sit above the command center's health bar, in board-local space.
    holder.getWorldPosition(tmpAnchor);
    rootObject.worldToLocal(tmpAnchor);
    const barY = holder.getObjectByName("HealthBar")?.position.y ?? 0;
    mesh.position.set(
      tmpAnchor.x,
      tmpAnchor.y + barY + COMMAND_CENTER_HUD_Y_OFFSET,
      tmpAnchor.z,
    );
    this.camera.getWorldPosition(tmpCamera);
    rootObject.worldToLocal(tmpCamera);
    mesh.rotation.y = Math.atan2(
      tmpCamera.x - mesh.position.x,
      tmpCamera.z - mesh.position.z,
    );
    mesh.visible = true;
  }
}

