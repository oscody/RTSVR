import { createSystem } from "@iwsdk/core";
import { advanceObjectTransitions } from "./objectTransitions.js";

/**
 * Drives the transitions in `objectTransitions.ts`, one frame at a time.
 *
 * The controller is a separate file because `@iwsdk/core` cannot be imported
 * by the node test runner — it fails at load with `document is not defined` —
 * and the controller carries the branching worth testing. Everything real is
 * next door; this is the six lines that could not go with it.
 */
export class ObjectTransitionSystem extends createSystem({}) {
  update(delta: number): void {
    advanceObjectTransitions(delta);
  }
}
