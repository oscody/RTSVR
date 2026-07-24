import { createSystem, type Entity } from "@iwsdk/core";
import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  type AnimationAction,
  type Object3D,
} from "three";
import { TURRET_ATTACK_SPEC } from "./combatRules.js";
import { TURRET_FIRE_RECOIL_CLIP } from "./constants.ts";
import {
  Building,
  CombatCapability,
  CombatState,
  Health,
} from "./state.js";

interface TurretAnimationController {
  action: AnimationAction;
  lastTimer: number;
  mixer: AnimationMixer;
  wasAttacking: boolean;
}

const controllers = new Map<number, TurretAnimationController>();

export function attachTurretAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const clip = AnimationClip.findByName(clips, TURRET_FIRE_RECOIL_CLIP);
  if (!clip) return;

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = false;

  controllers.set(entity.index, {
    action,
    lastTimer: 0,
    mixer,
    wasAttacking: false,
  });
}

export function detachTurretAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearTurretAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

function isFiringShot(
  controller: TurretAnimationController,
  attacking: boolean,
  timer: number,
): boolean {
  if (!attacking || !controller.wasAttacking) return false;
  return timer < controller.lastTimer || timer === 0 && controller.lastTimer > 0;
}

export class TurretAnimationSystem extends createSystem({
  turrets: { required: [Building, CombatCapability, CombatState, Health] },
}) {
  update(delta: number): void {
    const liveAnimatedTurrets = new Set<number>();
    for (const turret of this.queries.turrets.entities) {
      if (turret.getValue(Building, "kind") !== "turret") continue;

      const controller = controllers.get(turret.index);
      if (!controller) continue;
      liveAnimatedTurrets.add(turret.index);

      const attacking =
        (turret.getValue(Health, "current") ?? 0) > 0 &&
        turret.getValue(CombatState, "stage") === "attacking" &&
        Boolean(turret.getValue(CombatState, "target"));
      const timer = turret.getValue(CombatState, "timer") ?? 0;

      if (isFiringShot(controller, attacking, timer)) {
        controller.action.reset().play();
      }

      controller.wasAttacking = attacking;
      controller.lastTimer = attacking ? timer : TURRET_ATTACK_SPEC.cadence;
      controller.mixer.update(Math.max(0, delta));
    }

    for (const [entityIndex, controller] of controllers) {
      if (liveAnimatedTurrets.has(entityIndex)) continue;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
