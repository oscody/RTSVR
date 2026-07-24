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
  CombatState,
  ConstructionState,
  Health,
  Unit,
  UnitSelection,
} from "./state.js";

const WALK_CLIP = "Walk";
const SHOOT_CLIP = "Shoot";
const BEACON_PLACEMENT_CLIP = "BeaconPlacement";
const LASER_POINT_ASSIST_CLIP = "LaserPointAssist";
const CROSS_FADE_SECONDS = 0.12;

type UnitAnimationState = "idle" | "walk" | "shoot" | "beacon" | "laser";
type UnitActionState = Exclude<UnitAnimationState, "idle">;

interface UnitAnimationController {
  beaconDuration: number;
  current: UnitAnimationState;
  mixer: AnimationMixer;
  actions: Partial<Record<UnitActionState, AnimationAction>>;
}

const controllers = new Map<number, UnitAnimationController>();

export function attachUnitAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const walkClip = AnimationClip.findByName(clips, WALK_CLIP);
  const shootClip = AnimationClip.findByName(clips, SHOOT_CLIP);
  const beaconClip = AnimationClip.findByName(clips, BEACON_PLACEMENT_CLIP);
  const laserClip = AnimationClip.findByName(clips, LASER_POINT_ASSIST_CLIP);
  if (!walkClip && !shootClip && !beaconClip && !laserClip) return;

  const mixer = new AnimationMixer(root);
  const walk = walkClip ? mixer.clipAction(walkClip) : undefined;
  const shoot = shootClip ? mixer.clipAction(shootClip) : undefined;
  const beacon = beaconClip ? mixer.clipAction(beaconClip) : undefined;
  const laser = laserClip ? mixer.clipAction(laserClip) : undefined;

  walk?.setLoop(LoopRepeat, Infinity);
  shoot?.setLoop(LoopRepeat, Infinity);
  beacon?.setLoop(LoopOnce, 1);
  if (beacon) beacon.clampWhenFinished = true;
  laser?.setLoop(LoopRepeat, Infinity);

  controllers.set(entity.index, {
    beaconDuration: beaconClip?.duration ?? 0,
    current: "idle",
    mixer,
    actions: { walk, shoot, beacon, laser },
  });
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

  const previous = controller.actions[controller.current as UnitActionState];
  const next = controller.actions[nextState as UnitActionState];

  previous?.fadeOut(CROSS_FADE_SECONDS);
  if (next) {
    next.reset().fadeIn(CROSS_FADE_SECONDS).play();
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
