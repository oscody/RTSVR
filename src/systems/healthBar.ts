import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Entity,
  type Object3D,
} from "@iwsdk/core";
import { TILE_SIZE } from "./board.ts";
import {
  HEALTH_BAR_BACKGROUND_COLOR,
  HEALTH_BAR_CRITICAL_COLOR,
  HEALTH_BAR_FILL_NAME,
  HEALTH_BAR_HEALTHY_COLOR,
  HEALTH_BAR_WARNING_COLOR,
} from "./constants.ts";
import { Health } from "./state.ts";

export function attachHealthBar(holder: Object3D): void {
  const size = new Box3().setFromObject(holder).getSize(new Vector3());
  const width = Math.max(
    TILE_SIZE * 0.65,
    Math.min(size.x, TILE_SIZE * 1.8),
  );
  const bar = new Group();
  bar.name = "HealthBar";
  bar.userData.drawCat = "hbar"; // draw-call profiler category
  bar.position.y = Math.max(size.y, TILE_SIZE * 0.8) + TILE_SIZE * 0.18;
  bar.userData.fullWidth = width;

  const background = new Mesh(
    new BoxGeometry(width, 0.012, TILE_SIZE * 0.11),
    new MeshBasicMaterial({ color: HEALTH_BAR_BACKGROUND_COLOR, depthWrite: false }),
  );
  background.name = "HealthBarBackground";
  bar.add(background);

  const fill = new Mesh(
    new BoxGeometry(width, 0.016, TILE_SIZE * 0.075),
    new MeshBasicMaterial({ color: HEALTH_BAR_HEALTHY_COLOR, depthWrite: false }),
  );
  fill.name = HEALTH_BAR_FILL_NAME;
  fill.position.y = 0.009;
  bar.add(fill);
  holder.add(bar);
}

export function updateHealthBar(entity: Entity): void {
  const bar = entity.object3D?.getObjectByName("HealthBar");
  const fill = bar?.getObjectByName(HEALTH_BAR_FILL_NAME) as Mesh | undefined;
  if (!bar || !fill) return;
  const current = entity.getValue(Health, "current") ?? 0;
  const max = Math.max(1, entity.getValue(Health, "max") ?? 1);
  const ratio = Math.max(0, Math.min(1, current / max));
  const width = Number(bar.userData.fullWidth) || TILE_SIZE;
  fill.scale.x = Math.max(0.001, ratio);
  fill.position.x = -(width * (1 - ratio)) / 2;
  const material = fill.material as MeshBasicMaterial;
  material.color.setHex(
    ratio > 0.6
      ? HEALTH_BAR_HEALTHY_COLOR
      : ratio > 0.3
        ? HEALTH_BAR_WARNING_COLOR
        : HEALTH_BAR_CRITICAL_COLOR,
  );
}
