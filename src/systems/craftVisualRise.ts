import { Object3D, createSystem, type Entity } from "@iwsdk/core";
import { CRAFT_ELEVATION_RISE_SECONDS } from "./constants.ts";

interface CraftVisualRiseController {
  model: Object3D;
  fromY: number;
  toY: number;
  timer: number;
  duration: number;
}

const controllers = new Map<number, CraftVisualRiseController>();

export function attachCraftVisualRise(
  entity: Entity,
  model: Object3D,
  toY: number,
): void {
  if (toY <= model.position.y) return;
  controllers.set(entity.index, {
    model,
    fromY: model.position.y,
    toY,
    timer: 0,
    duration: CRAFT_ELEVATION_RISE_SECONDS,
  });
}

export function clearCraftVisualRise(): void {
  controllers.clear();
}

export class CraftVisualRiseSystem extends createSystem({}) {
  update(delta: number): void {
    for (const entityIndex of controllers.keys()) {
      const controller = controllers.get(entityIndex)!;
      if (!controller.model.parent) {
        controllers.delete(entityIndex);
        continue;
      }
      controller.timer += Math.max(0, delta);
      const t = Math.min(1, controller.timer / controller.duration);
      const eased = t * t * (3 - 2 * t);
      controller.model.position.y =
        controller.fromY + (controller.toY - controller.fromY) * eased;
      if (t >= 1) controllers.delete(entityIndex);
    }
  }
}
