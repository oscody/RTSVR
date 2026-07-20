import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  DEFAULT_RESOURCE_CAPACITY,
  LARGE_CRYSTAL_NODE_CAPACITY,
  MINING_GATHER_TIME_SECONDS,
  SMALL_CRYSTAL_NODE_CAPACITY,
  STARTING_CRYSTALS,
} from "../src/systems/economyConstants.ts";
import { advanceMiningCycle } from "../src/systems/miningRules.ts";
import type { MiningCycleState } from "../src/systems/miningRules.ts";

function completeCycle(state: MiningCycleState): void {
  assert.equal(advanceMiningCycle(state, 0, true), "startedGathering");
  assert.equal(state.stage, "gathering");

  const beforeGather = state.crystals;
  assert.equal(
    advanceMiningCycle(state, MINING_GATHER_TIME_SECONDS, false),
    "loadedCargo",
  );
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

test("economy constants define the resource baseline", () => {
  assert.deepEqual(
    {
      startingCrystals: STARTING_CRYSTALS,
      defaultCapacity: DEFAULT_RESOURCE_CAPACITY,
      amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
      gatherTime: MINING_GATHER_TIME_SECONDS,
      largeCapacity: LARGE_CRYSTAL_NODE_CAPACITY,
      smallCapacity: SMALL_CRYSTAL_NODE_CAPACITY,
    },
    {
      startingCrystals: 0,
      defaultCapacity: 50,
      amountPerTrip: 10,
      gatherTime: 1.1,
      largeCapacity: 100,
      smallCapacity: 50,
    },
  );
});

test("three mining cycles add crystals only during deposit", () => {
  const state: MiningCycleState = {
    stage: "toResource",
    timer: 0,
    cargo: 0,
    nodeRemaining: LARGE_CRYSTAL_NODE_CAPACITY,
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    crystals: STARTING_CRYSTALS,
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
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    crystals: 20,
  };

  completeCycle(state);

  assert.equal(state.crystals, 26);
  assert.equal(state.nodeRemaining, 0);
  assert.equal(state.stage, "idle");
});
