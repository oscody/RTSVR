import { createSystem, type Entity } from "@iwsdk/core";
import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type Object3D,
} from "three";
import {
  ANIMATION_CROSS_FADE_SECONDS,
  UNIT_ATTACK_CLIPS,
  UNIT_BEACON_PLACEMENT_CLIP,
  UNIT_IDLE_CLIPS,
  UNIT_LASER_POINT_ASSIST_CLIP,
  UNIT_MOVE_CLIPS,
} from "./constants.ts";
import {
  CombatState,
  ConstructionState,
  Health,
  Unit,
  UnitSelection,
} from "./state.js";

type UnitAnimationState = "idle" | "walk" | "shoot" | "beacon" | "laser";

interface UnitAnimationController {
  beaconDuration: number;
  current: UnitAnimationState;
  mixer: AnimationMixer;
  actions: Partial<Record<UnitAnimationState, AnimationAction>>;
}

const controllers = new Map<number, UnitAnimationController>();

function findFirstClip(
  clips: AnimationClip[],
  names: readonly string[],
): AnimationClip | undefined {
  for (const name of names) {
    const clip = AnimationClip.findByName(clips, name);
    if (clip) return clip;
  }
  return undefined;
}

export function attachUnitAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const idleClip = findFirstClip(clips, UNIT_IDLE_CLIPS);
  const walkClip = findFirstClip(clips, UNIT_MOVE_CLIPS);
  const shootClip = findFirstClip(clips, UNIT_ATTACK_CLIPS);
  const beaconClip = AnimationClip.findByName(
    clips,
    UNIT_BEACON_PLACEMENT_CLIP,
  );
  const laserClip = AnimationClip.findByName(
    clips,
    UNIT_LASER_POINT_ASSIST_CLIP,
  );
  if (!idleClip && !walkClip && !shootClip && !beaconClip && !laserClip) return;

  const mixer = new AnimationMixer(root);
  const idle = idleClip ? mixer.clipAction(idleClip) : undefined;
  const walk = walkClip ? mixer.clipAction(walkClip) : undefined;
  const shoot = shootClip ? mixer.clipAction(shootClip) : undefined;
  const beacon = beaconClip ? mixer.clipAction(beaconClip) : undefined;
  const laser = laserClip ? mixer.clipAction(laserClip) : undefined;

  idle?.setLoop(LoopRepeat, Infinity);
  walk?.setLoop(LoopRepeat, Infinity);
  shoot?.setLoop(LoopRepeat, Infinity);
  beacon?.setLoop(LoopOnce, 1);
  if (beacon) beacon.clampWhenFinished = true;
  laser?.setLoop(LoopRepeat, Infinity);

  controllers.set(entity.index, {
    beaconDuration: beaconClip?.duration ?? 0,
    current: "idle",
    mixer,
    actions: { idle, walk, shoot, beacon, laser },
  });
  idle?.play();
}

export function detachUnitAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearUnitAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

function desiredAnimation(
  entity: Entity,
  controller: UnitAnimationController,
): UnitAnimationState {
  if ((entity.getValue(Health, "current") ?? 0) <= 0) return "idle";
  if (entity.getValue(CombatState, "stage") === "attacking") return "shoot";
  if (entity.hasComponent(ConstructionState)) {
    const constructionStage =
      entity.getValue(ConstructionState, "stage") ?? "idle";
    if (constructionStage === "building") {
      const timer = entity.getValue(ConstructionState, "timer") ?? 0;
      return timer < controller.beaconDuration ? "beacon" : "laser";
    }
  }
  if (
    (entity.getValue(Unit, "hasOrder") ?? false) ||
    entity.getValue(CombatState, "stage") === "approaching"
  ) {
    return "walk";
  }
  return "idle";
}

function playAnimation(
  controller: UnitAnimationController,
  nextState: UnitAnimationState,
): void {
  if (controller.current === nextState) return;

  const previous = controller.actions[controller.current];
  const next = controller.actions[nextState];

  previous?.fadeOut(ANIMATION_CROSS_FADE_SECONDS);
  if (next) {
    next.reset().fadeIn(ANIMATION_CROSS_FADE_SECONDS).play();
  }
  controller.current = nextState;
}

export class UnitAnimationSystem extends createSystem({
  units: { required: [Unit, UnitSelection, CombatState, Health] },
}) {
  update(delta: number): void {
    const liveAnimatedUnits = new Set<number>();
    for (const unit of this.queries.units.entities) {
      const controller = controllers.get(unit.index);
      if (!controller) continue;
      liveAnimatedUnits.add(unit.index);
      playAnimation(controller, desiredAnimation(unit, controller));
      controller.mixer.update(Math.max(0, delta));
    }

    for (const [entityIndex, controller] of controllers) {
      if (liveAnimatedUnits.has(entityIndex)) continue;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
