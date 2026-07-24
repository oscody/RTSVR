import { createSystem, type Entity } from "@iwsdk/core";
import {
  AnimationClip,
  AnimationMixer,
  LoopRepeat,
  type AnimationAction,
  type Object3D,
} from "three";
import { Health, MinerState, Unit } from "./state.js";

const IDLE_CLIP = "Idle_Hover";
const MOVE_CLIP = "Move";
const MINING_CLIP = "Mining_Loop";
const CROSS_FADE_SECONDS = 0.12;

type MinerAnimationState = "idle" | "move" | "mine";

interface MinerAnimationController {
  current: MinerAnimationState;
  mixer: AnimationMixer;
  actions: Partial<Record<MinerAnimationState, AnimationAction>>;
}

const controllers = new Map<number, MinerAnimationController>();

export function attachMinerAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const idleClip = AnimationClip.findByName(clips, IDLE_CLIP);
  const moveClip = AnimationClip.findByName(clips, MOVE_CLIP);
  const miningClip = AnimationClip.findByName(clips, MINING_CLIP);
  if (!idleClip && !moveClip && !miningClip) return;

  const mixer = new AnimationMixer(root);
  const idle = idleClip ? mixer.clipAction(idleClip) : undefined;
  const move = moveClip ? mixer.clipAction(moveClip) : undefined;
  const mine = miningClip ? mixer.clipAction(miningClip) : undefined;

  idle?.setLoop(LoopRepeat, Infinity);
  move?.setLoop(LoopRepeat, Infinity);
  mine?.setLoop(LoopRepeat, Infinity);

  controllers.set(entity.index, {
    current: "idle",
    mixer,
    actions: { idle, move, mine },
  });
  idle?.play();
}

export function detachMinerAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearMinerAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

function desiredAnimation(entity: Entity): MinerAnimationState {
  if ((entity.getValue(Health, "current") ?? 0) <= 0) return "idle";
  if (entity.getValue(MinerState, "stage") === "gathering") return "mine";
  if (
    (entity.getValue(Unit, "hasOrder") ?? false) ||
    entity.getValue(MinerState, "stage") === "toResource" ||
    entity.getValue(MinerState, "stage") === "toBase"
  ) {
    return "move";
  }
  return "idle";
}

function playAnimation(
  controller: MinerAnimationController,
  nextState: MinerAnimationState,
): void {
  if (controller.current === nextState) return;

  const previous = controller.actions[controller.current];
  const next = controller.actions[nextState];

  previous?.fadeOut(CROSS_FADE_SECONDS);
  if (next) {
    next.reset().fadeIn(CROSS_FADE_SECONDS).play();
  }
  controller.current = nextState;
}

export class MinerAnimationSystem extends createSystem({
  miners: { required: [Unit, MinerState, Health] },
}) {
  update(delta: number): void {
    const liveAnimatedMiners = new Set<number>();
    for (const miner of this.queries.miners.entities) {
      const controller = controllers.get(miner.index);
      if (!controller) continue;
      liveAnimatedMiners.add(miner.index);
      playAnimation(controller, desiredAnimation(miner));
      controller.mixer.update(Math.max(0, delta));
    }

    for (const [entityIndex, controller] of controllers) {
      if (liveAnimatedMiners.has(entityIndex)) continue;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
