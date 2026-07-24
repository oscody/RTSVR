import { type Entity } from "@iwsdk/core";
import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  type AnimationAction,
  type Object3D,
} from "three";
import { CRAFT_SPAWN_CONSTRUCTION_CLIP } from "./constants.ts";

interface CraftProductionAnimationController {
  action: AnimationAction;
  mixer: AnimationMixer;
}

const controllers = new Map<number, CraftProductionAnimationController>();

export function attachCraftProductionAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
  duration: number,
): void {
  const clip = AnimationClip.findByName(clips, CRAFT_SPAWN_CONSTRUCTION_CLIP);
  if (!clip) return;

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  if (duration > 0 && clip.duration > 0) {
    action.setEffectiveTimeScale(clip.duration / duration);
  }
  action.play();

  controllers.set(entity.index, { action, mixer });
}

export function detachCraftProductionAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearCraftProductionAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

export function updateCraftProductionAnimation(
  entity: Entity,
  delta: number,
): void {
  controllers.get(entity.index)?.mixer.update(Math.max(0, delta));
}
