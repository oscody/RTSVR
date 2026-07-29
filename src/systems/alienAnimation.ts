import {
  AnimationClip,
  AnimationMixer,
  LoopRepeat,
  createSystem,
  type AnimationAction,
  type Entity,
  type Object3D,
} from "@iwsdk/core";
import {
  ALIEN_ATTACK_CLIPS,
  ALIEN_MOVE_CLIPS,
  ANIMATION_CROSS_FADE_SECONDS,
} from "./constants.ts";
import { CombatState, Enemy, Health, WaveUnit } from "./state.js";

type AlienAnimationState = "idle" | "move" | "attack";

interface AlienAnimationController {
  current: AlienAnimationState;
  mixer: AnimationMixer;
  actions: Partial<Record<Exclude<AlienAnimationState, "idle">, AnimationAction>>;
}

const controllers = new Map<number, AlienAnimationController>();

function findClipByNames(
  clips: AnimationClip[],
  names: readonly string[],
): AnimationClip | undefined {
  for (const name of names) {
    const clip = AnimationClip.findByName(clips, name);
    if (clip) return clip;
  }
  return undefined;
}

export function attachAlienAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const moveClip = findClipByNames(clips, ALIEN_MOVE_CLIPS);
  const attackClip = findClipByNames(clips, ALIEN_ATTACK_CLIPS);
  if (!moveClip && !attackClip) return;

  const mixer = new AnimationMixer(root);
  const move = moveClip ? mixer.clipAction(moveClip) : undefined;
  const attack = attackClip ? mixer.clipAction(attackClip) : undefined;

  move?.setLoop(LoopRepeat, Infinity);
  attack?.setLoop(LoopRepeat, Infinity);

  controllers.set(entity.index, {
    current: "idle",
    mixer,
    actions: { move, attack },
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
    return "attack";
  }
  if (
    (entity.getValue(WaveUnit, "hasWaypoint") ?? false) ||
    entity.getValue(WaveUnit, "stage") === "marching" ||
    entity.getValue(CombatState, "stage") === "approaching"
  ) {
    return "move";
  }
  return "idle";
}

function playAnimation(
  controller: AlienAnimationController,
  nextState: AlienAnimationState,
): void {
  if (controller.current === nextState) return;

  const previous = controller.actions[controller.current as "move" | "attack"];
  const next = controller.actions[nextState as "move" | "attack"];

  previous?.fadeOut(ANIMATION_CROSS_FADE_SECONDS);
  if (next) {
    next.reset().fadeIn(ANIMATION_CROSS_FADE_SECONDS).play();
  }
  controller.current = nextState;
}

export class AlienAnimationSystem extends createSystem({
  aliens: { required: [Enemy, WaveUnit, CombatState, Health] },
}) {
  private readonly liveAnimatedAliens = new Set<number>();

  update(delta: number): void {
    const frameDelta = Math.max(0, delta);
    this.liveAnimatedAliens.clear();
    for (const alien of this.queries.aliens.entities) {
      const controller = controllers.get(alien.index);
      if (!controller) continue;
      this.liveAnimatedAliens.add(alien.index);
      if (alien.getValue(WaveUnit, "stage") === "waiting") continue;
      playAnimation(controller, desiredAnimation(alien));
      controller.mixer.update(frameDelta);
    }

    for (const entityIndex of controllers.keys()) {
      if (this.liveAnimatedAliens.has(entityIndex)) continue;
      const controller = controllers.get(entityIndex)!;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
