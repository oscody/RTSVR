import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  createSystem,
  type AnimationAction,
  type Entity,
  type Object3D,
} from "@iwsdk/core";
import {
  COMMAND_CENTER_DOOR_CLOSE_CLIP,
  COMMAND_CENTER_DOOR_HOLD_SECONDS,
  COMMAND_CENTER_DOOR_OPEN_CLIP,
  COMMAND_CENTER_IDLE_OPERATIONAL_CLIP,
} from "./constants.ts";
import { Building, Health } from "./state.js";

type DoorPhase = "idle" | "opening" | "holding" | "closing";

interface CommandCenterAnimationController {
  closeAction?: AnimationAction;
  closeDuration: number;
  doorPhase: DoorPhase;
  doorTimer: number;
  idleAction: AnimationAction;
  mixer: AnimationMixer;
  openAction?: AnimationAction;
  openDuration: number;
}

const controllers = new Map<number, CommandCenterAnimationController>();

export function attachCommandCenterAnimation(
  entity: Entity,
  root: Object3D,
  clips: AnimationClip[],
): void {
  const idleClip = AnimationClip.findByName(
    clips,
    COMMAND_CENTER_IDLE_OPERATIONAL_CLIP,
  );
  const openClip = AnimationClip.findByName(
    clips,
    COMMAND_CENTER_DOOR_OPEN_CLIP,
  );
  const closeClip = AnimationClip.findByName(
    clips,
    COMMAND_CENTER_DOOR_CLOSE_CLIP,
  );
  if (!idleClip && !openClip && !closeClip) return;

  const mixer = new AnimationMixer(root);
  const idleAction = idleClip
    ? mixer.clipAction(idleClip)
    : mixer.clipAction(new AnimationClip("CommandCenterEmptyIdle", 1, []));
  idleAction.setLoop(LoopRepeat, Infinity);
  idleAction.play();

  const openAction = openClip ? mixer.clipAction(openClip) : undefined;
  const closeAction = closeClip ? mixer.clipAction(closeClip) : undefined;
  openAction?.setLoop(LoopOnce, 1);
  closeAction?.setLoop(LoopOnce, 1);
  if (openAction) openAction.clampWhenFinished = true;
  if (closeAction) closeAction.clampWhenFinished = false;

  controllers.set(entity.index, {
    closeAction,
    closeDuration: closeClip?.duration ?? 0,
    doorPhase: "idle",
    doorTimer: 0,
    idleAction,
    mixer,
    openAction,
    openDuration: openClip?.duration ?? 0,
  });
}

export function detachCommandCenterAnimation(entity: Entity): void {
  const controller = controllers.get(entity.index);
  if (!controller) return;
  controller.mixer.stopAllAction();
  controllers.delete(entity.index);
}

export function clearCommandCenterAnimations(): void {
  for (const controller of controllers.values()) {
    controller.mixer.stopAllAction();
  }
  controllers.clear();
}

export function triggerCommandCenterDepositDoors(entity: Entity | null): void {
  if (!entity) return;
  const controller = controllers.get(entity.index);
  if (!controller?.openAction && !controller?.closeAction) return;

  controller.closeAction?.stop();
  controller.openAction?.reset().play();
  controller.doorPhase = controller.openAction ? "opening" : "closing";
  controller.doorTimer = 0;

  if (!controller.openAction) {
    controller.closeAction?.reset().play();
  }
}

function updateDoorSequence(
  controller: CommandCenterAnimationController,
  delta: number,
): void {
  if (controller.doorPhase === "idle") return;

  controller.doorTimer += delta;
  if (
    controller.doorPhase === "opening" &&
    controller.doorTimer >= controller.openDuration
  ) {
    controller.doorPhase = "holding";
    controller.doorTimer = 0;
    return;
  }
  if (
    controller.doorPhase === "holding" &&
    controller.doorTimer >= COMMAND_CENTER_DOOR_HOLD_SECONDS
  ) {
    controller.openAction?.stop();
    controller.closeAction?.reset().play();
    controller.doorPhase = controller.closeAction ? "closing" : "idle";
    controller.doorTimer = 0;
    return;
  }
  if (
    controller.doorPhase === "closing" &&
    controller.doorTimer >= controller.closeDuration
  ) {
    controller.closeAction?.stop();
    controller.doorPhase = "idle";
    controller.doorTimer = 0;
  }
}

export class CommandCenterAnimationSystem extends createSystem({
  commandCenters: { required: [Building, Health] },
}) {
  private readonly liveAnimatedCommandCenters = new Set<number>();

  update(delta: number): void {
    const frameDelta = Math.max(0, delta);
    this.liveAnimatedCommandCenters.clear();
    for (const commandCenter of this.queries.commandCenters.entities) {
      if (commandCenter.getValue(Building, "kind") !== "command-center") continue;

      const controller = controllers.get(commandCenter.index);
      if (!controller) continue;
      this.liveAnimatedCommandCenters.add(commandCenter.index);

      if ((commandCenter.getValue(Health, "current") ?? 0) > 0) {
        updateDoorSequence(controller, frameDelta);
        controller.mixer.update(frameDelta);
      }
    }

    for (const entityIndex of controllers.keys()) {
      if (this.liveAnimatedCommandCenters.has(entityIndex)) continue;
      const controller = controllers.get(entityIndex)!;
      controller.mixer.stopAllAction();
      controllers.delete(entityIndex);
    }
  }
}
