import { createSystem, type Entity } from "@iwsdk/core";
import {
  AnimationClip,
  AnimationMixer,
  LoopRepeat,
  type AnimationAction,
  type Object3D,
} from "three";
import { CombatState, Enemy, Health, WaveUnit } from "./state.js";

const WALK_CLIP = "Walk";
const SLAM_CLIP = "Energy_Slam";
const CROSS_FADE_SECONDS = 0.12;

type AlienAnimationState = "idle" | "walk" | "slam";

interface AlienAnimationController {
  current: AlienAnimationState;
  mixer: AnimationMixer;
  actions: Partial<Record<Exclude<AlienAnimationState, "idle">, AnimationAction>>;
}

const controllers = new Map<number, AlienAnimationController>();

export function attachAlienAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const walkClip = AnimationClip.findByName(clips, WALK_CLIP);
  const slamClip = AnimationClip.findByName(clips, SLAM_CLIP);
  if (!walkClip && !slamClip) return;

  const mixer = new AnimationMixer(root);
  const walk = walkClip ? mixer.clipAction(walkClip) : undefined;
  const slam = slamClip ? mixer.clipAction(slamClip) : undefined;

  walk?.setLoop(LoopRepeat, Infinity);
  slam?.setLoop(LoopRepeat, Infinity);

  controllers.set(entity.index, {
    current: "idle",
    mixer,
    actions: { walk, slam },
  });
}

export function detachAlienAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearAlienAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

function desiredAnimation(entity: Entity): AlienAnimationState {
  if ((entity.getValue(Health, "current") ?? 0) <= 0) return "idle";
  if (
    entity.getValue(CombatState, "stage") === "attacking" ||
    entity.getValue(WaveUnit, "stage") === "attacking"
  ) {
    return "slam";
  }
  if (
    (entity.getValue(WaveUnit, "hasWaypoint") ?? false) ||
    entity.getValue(WaveUnit, "stage") === "marching" ||
    entity.getValue(CombatState, "stage") === "approaching"
  ) {
    return "walk";
  }
  return "idle";
}

function playAnimation(
  controller: AlienAnimationController,
  nextState: AlienAnimationState,
): void {
  if (controller.current === nextState) return;

  const previous = controller.actions[controller.current as "walk" | "slam"];
  const next = controller.actions[nextState as "walk" | "slam"];

  previous?.fadeOut(CROSS_FADE_SECONDS);
  if (next) {
    next.reset().fadeIn(CROSS_FADE_SECONDS).play();
  }
  controller.current = nextState;
}

export class AlienAnimationSystem extends createSystem({
  aliens: { required: [Enemy, WaveUnit, CombatState, Health] },
}) {
  update(delta: number): void {
    const liveAnimatedAliens = new Set<number>();
    for (const alien of this.queries.aliens.entities) {
      const controller = controllers.get(alien.index);
      if (!controller) continue;
      liveAnimatedAliens.add(alien.index);
      playAnimation(controller, desiredAnimation(alien));
      controller.mixer.update(Math.max(0, delta));
    }

    for (const [entityIndex, controller] of controllers) {
      if (liveAnimatedAliens.has(entityIndex)) continue;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
