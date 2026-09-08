import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  DEFAULT_RESOURCE_CAPACITY,
  LARGE_CRYSTAL_NODE_CAPACITY,
  MINING_DEPOSIT_TIME_SECONDS,
  MINING_GATHER_TIME_SECONDS,
  SMALL_CRYSTAL_NODE_CAPACITY,
  STARTING_CRYSTALS,
} from "../src/systems/economyConstants.ts";
import {
  advanceMiningCycle,
  selectNearestMiningTarget,
} from "../src/systems/miningRules.ts";
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

  assert.equal(
    advanceMiningCycle(state, MINING_DEPOSIT_TIME_SECONDS, false),
    "deposited",
  );
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
      depositTime: MINING_DEPOSIT_TIME_SECONDS,
      largeCapacity: LARGE_CRYSTAL_NODE_CAPACITY,
      smallCapacity: SMALL_CRYSTAL_NODE_CAPACITY,
    },
    {
      startingCrystals: 0,
      defaultCapacity: 50,
      amountPerTrip: 10,
      gatherTime: 5,
      depositTime: 1.5,
      largeCapacity: 1000,
      smallCapacity: 100,
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
    depositDuration: MINING_DEPOSIT_TIME_SECONDS,
    crystals: STARTING_CRYSTALS,
  };

  completeCycle(state);
  completeCycle(state);
  completeCycle(state);

  assert.equal(state.crystals, 30);
  assert.equal(state.nodeRemaining, 970);
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
    depositDuration: MINING_DEPOSIT_TIME_SECONDS,
    crystals: 20,
  };

  completeCycle(state);

  assert.equal(state.crystals, 26);
  assert.equal(state.nodeRemaining, 0);
  assert.equal(state.stage, "idle");
});

test("the deposit stage holds the miner for its duration", () => {
  const state: MiningCycleState = {
    stage: "deposit",
    timer: 0,
    cargo: 10,
    nodeRemaining: 40,
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    depositDuration: MINING_DEPOSIT_TIME_SECONDS,
    crystals: 20,
  };

  // The defect this guards: before 2026-09-08 the deposit branch had no timer,
  // so this first call credited immediately and the miner left inside one frame.
  assert.equal(advanceMiningCycle(state, 0.5, false), "none");
  assert.equal(state.crystals, 20, "nothing is credited mid-deposit");
  assert.equal(state.cargo, 10, "the miner is still carrying it");
  assert.equal(state.stage, "deposit");

  assert.equal(advanceMiningCycle(state, 0.5, false), "none");
  assert.equal(state.crystals, 20);

  assert.equal(advanceMiningCycle(state, 0.5, false), "deposited");
  assert.equal(state.crystals, 30);
  assert.equal(state.cargo, 0);
  assert.equal(state.stage, "toResource");
  assert.equal(state.timer, 0, "the timer resets for the next cycle");
});

test("a zero deposit duration credits on the first frame, as it did before", () => {
  const state: MiningCycleState = {
    stage: "deposit",
    timer: 0,
    cargo: 10,
    nodeRemaining: 40,
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    depositDuration: 0,
    crystals: 20,
  };

  assert.equal(advanceMiningCycle(state, 0, false), "deposited");
  assert.equal(state.crystals, 30);
});

test("miner cannot deposit after the command center is unavailable", () => {
  const state: MiningCycleState = {
    stage: "deposit",
    timer: 0,
    cargo: 10,
    nodeRemaining: 40,
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    depositDuration: MINING_DEPOSIT_TIME_SECONDS,
    crystals: 20,
  };

  assert.equal(advanceMiningCycle(state, 0, true, false), "baseUnavailable");
  assert.equal(state.crystals, 20);
  assert.equal(state.cargo, 0);
  assert.equal(state.stage, "idle");
});

test("automatic mining chooses the nearest non-empty node with an approach", () => {
  const candidates = [
    { target: "empty", x: 2, y: 2, remaining: 0 },
    { target: "blocked", x: 3, y: 3, remaining: 50 },
    { target: "far", x: 10, y: 10, remaining: 100 },
    { target: "nearest", x: 6, y: 4, remaining: 50 },
  ];
  const approaches = new Map([
    ["far", { x: 9, y: 10 }],
    ["nearest", { x: 5, y: 4 }],
  ]);

  const selection = selectNearestMiningTarget(
    { x: 4, y: 4 },
    candidates,
    ({ target }) => approaches.get(target) ?? null,
  );

  assert.deepEqual(selection, {
    target: "nearest",
    x: 6,
    y: 4,
    approach: { x: 5, y: 4 },
  });
});

test("automatic mining stops when no usable resource remains", () => {
  const selection = selectNearestMiningTarget(
    { x: 4, y: 4 },
    [
      { target: "empty", x: 2, y: 2, remaining: 0 },
      { target: "blocked", x: 3, y: 3, remaining: 50 },
    ],
    () => null,
  );

  assert.equal(selection, null);
});
