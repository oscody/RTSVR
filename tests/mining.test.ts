import assert from "node:assert/strict";
import test from "node:test";

import { advanceMiningCycle } from "../src/systems/miningRules.ts";
import type { MiningCycleState } from "../src/systems/miningRules.ts";

function completeCycle(state: MiningCycleState): void {
  assert.equal(advanceMiningCycle(state, 0, true), "startedGathering");
  assert.equal(state.stage, "gathering");

  const beforeGather = state.crystals;
  assert.equal(advanceMiningCycle(state, 1.1, false), "loadedCargo");
  assert.equal(state.stage, "toBase");
  assert.equal(state.crystals, beforeGather, "gathering must not change the stockpile");

  const carried = state.cargo;
  assert.equal(advanceMiningCycle(state, 0, true), "reachedBase");
  assert.equal(state.stage, "deposit");
  assert.equal(state.crystals, beforeGather, "carrying must not change the stockpile");

  assert.equal(advanceMiningCycle(state, 0, false), "deposited");
  assert.equal(state.crystals, beforeGather + carried);
  assert.equal(state.cargo, 0);
}

test("three mining cycles add crystals only during deposit", () => {
  const state: MiningCycleState = {
    stage: "toResource",
    timer: 0,
    cargo: 0,
    nodeRemaining: 100,
    amountPerTrip: 10,
    crystals: 0,
  };

  completeCycle(state);
  completeCycle(state);
  completeCycle(state);

  assert.equal(state.crystals, 30);
  assert.equal(state.nodeRemaining, 70);
  assert.equal(state.stage, "toResource");
});

test("the final trip cannot extract more than the node has", () => {
  const state: MiningCycleState = {
    stage: "toResource",
    timer: 0,
    cargo: 0,
    nodeRemaining: 6,
    amountPerTrip: 10,
    crystals: 20,
  };

  completeCycle(state);

  assert.equal(state.crystals, 26);
  assert.equal(state.nodeRemaining, 0);
  assert.equal(state.stage, "idle");
});
