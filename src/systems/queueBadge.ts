import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  type Object3D,
} from "@iwsdk/core";
import { TILE_SIZE } from "./board.js";
import {
  QUEUE_BADGE_BACKGROUND_COLOR,
  QUEUE_BADGE_SIZE,
  QUEUE_BADGE_TEXT_COLOR,
  QUEUE_BADGE_Y_OFFSET,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";

export const QUEUE_BADGE_NAME = "QueueBadge";

// One shared plane for every badge, and one cached material per number. A board
// full of queued orders therefore costs a handful of draw calls and exactly as
// many textures as there are distinct positions on screen.
const badgeGeometry = new PlaneGeometry(
  TILE_SIZE * QUEUE_BADGE_SIZE,
  TILE_SIZE * QUEUE_BADGE_SIZE,
);
const materialByLabel = new Map<string, MeshBasicMaterial>();

function badgeLabel(position: number): string {
  return position > 9 ? "9+" : String(position);
}

function badgeMaterial(label: string): MeshBasicMaterial {
  const cached = materialByLabel.get(label);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = QUEUE_BADGE_BACKGROUND_COLOR;
  ctx.fill();
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = QUEUE_BADGE_TEXT_COLOR;
  ctx.stroke();
  ctx.fillStyle = QUEUE_BADGE_TEXT_COLOR;
  ctx.font = `bold ${size * (label.length > 1 ? 0.44 : 0.58)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size / 2 + size * 0.02);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // Additive-free and untone-mapped, or the badge washes out to white over
    // the bright board the way the early combat VFX did.
    toneMapped: false,
  });
  materialByLabel.set(label, material);
  return material;
}

// Attaches the badge in the same spirit as attachHealthBar: a small floating
// marker parented to the site holder, hidden until it has something to say.
export function attachQueueBadge(holder: Object3D): void {
  const badge = new Mesh(badgeGeometry, badgeMaterial("1"));
  makeNonInteractive(badge);
  badge.name = QUEUE_BADGE_NAME;
  badge.userData.drawCat = "hbar"; // shares the health-bar profiler category
  badge.position.y = TILE_SIZE * QUEUE_BADGE_Y_OFFSET;
  badge.visible = false;
  holder.add(badge);
}

// `position` is the 1-based place in the build queue, or null to hide (the site
// is being worked on, so its progress bar has taken over).
export function setQueueBadge(
  holder: Object3D | null | undefined,
  position: number | null,
): void {
  const badge = holder?.getObjectByName(QUEUE_BADGE_NAME) as Mesh | undefined;
  if (!badge) return;
  if (position === null) {
    badge.visible = false;
    return;
  }
  const label = badgeLabel(position);
  if (badge.userData.label !== label) {
    badge.userData.label = label;
    badge.material = badgeMaterial(label);
  }
  badge.visible = true;
}

// Flat planes vanish edge-on, and the board is looked at from every angle in
// VR, so the badge turns to face the viewer. Only pending sites have a visible
// badge, so this runs for a handful of objects at most.
export function faceQueueBadge(
  holder: Object3D | null | undefined,
  cameraPosition: Vector3,
): void {
  const badge = holder?.getObjectByName(QUEUE_BADGE_NAME) as Mesh | undefined;
  if (!badge?.visible) return;
  badge.lookAt(cameraPosition);
}
