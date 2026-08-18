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
import { waveTotalEnemyCount } from "./waveCatalog.js";

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
  hudTexture.anisotropy = 4;
  hudMaterial = new MeshBasicMaterial({
    map: hudTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  hudMesh = new Mesh(
    new PlaneGeometry(COMMAND_CENTER_HUD_WIDTH, COMMAND_CENTER_HUD_HEIGHT),
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

  const labelFont = `600 ${Math.round(height * 0.3)}px sans-serif`;
  const valueFont = `bold ${Math.round(height * 0.42)}px sans-serif`;
  const midY = height * 0.54;
  context.textBaseline = "middle";
  context.textAlign = "left";

  let x = width * 0.045;
  const write = (text: string, font: string, color: string): void => {
    context.font = font;
    context.fillStyle = color;
    context.fillText(text, x, midY);
    x += context.measureText(text).width;
  };
  const gap = (): void => {
    x += width * 0.03;
  };

  write("LEVEL ", labelFont, COMMAND_CENTER_HUD_LABEL_COLOR);
  write(String(level), valueFont, COMMAND_CENTER_HUD_VALUE_COLOR);
  gap();
  write("TROOPS ", labelFont, COMMAND_CENTER_HUD_LABEL_COLOR);
  // Remaining AND the level's total. The count alone was ambiguous — "11"
  // answers neither "how many are left" nor "out of how many", and colour is
  // too weak a channel to carry that on its own. The total is dimmed so the
  // number that changes is the one that reads first.
  const ratio = total > 0 ? remaining / total : 0;
  write(
    String(remaining),
    valueFont,
    ratio <= COMMAND_CENTER_HUD_TROOPS_LOW_RATIO
      ? COMMAND_CENTER_HUD_TROOPS_LOW_COLOR
      : COMMAND_CENTER_HUD_TROOPS_HIGH_COLOR,
  );
  write(`/${total}`, labelFont, COMMAND_CENTER_HUD_LABEL_COLOR);
  gap();
  write("GEMS ", labelFont, COMMAND_CENTER_HUD_LABEL_COLOR);
  write(String(crystals), valueFont, COMMAND_CENTER_HUD_GEM_COLOR);

  hudTexture.needsUpdate = true;
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
