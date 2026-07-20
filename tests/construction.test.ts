import assert from "node:assert/strict";
import test from "node:test";

import { getBuildingSpec } from "../src/systems/buildingCatalog.ts";
import {
  advanceConstruction,
  constructionProgress,
  footprintApproaches,
  footprintCells,
  validateBuildOrder,
} from "../src/systems/constructionRules.ts";
import type { ConstructionCycleState } from "../src/systems/constructionRules.ts";

test("building footprints stay centered on the selected anchor convention", () => {
  assert.deepEqual(footprintCells(7, 11, 2), [
    { x: 7, y: 11 },
    { x: 8, y: 11 },
    { x: 7, y: 12 },
    { x: 8, y: 12 },
  ]);
  assert.equal(footprintCells(15, 11, 3).length, 9);
  assert.equal(footprintApproaches(15, 11, 3, 24).length, 12);
});

test("valid construction deducts exactly one catalog cost", () => {
  const spec = getBuildingSpec("hangar");
  const result = validateBuildOrder({
    spec,
    crystals: 100,
    builderIdle: true,
    footprintValid: true,
    pathFound: true,
  });

  assert.deepEqual(result, { ok: true, remainingCrystals: 60 });
  assert.equal(spec?.kind, "hangar");
});

test("invalid construction requests preserve the balance", () => {
  const unlocked = getBuildingSpec("factory");
  const locked = getBuildingSpec("relay");
  const cases = [
    validateBuildOrder({ spec: locked, crystals: 100, builderIdle: true, footprintValid: true, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 10, builderIdle: true, footprintValid: true, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 100, builderIdle: true, footprintValid: false, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 100, builderIdle: true, footprintValid: true, pathFound: false }),
    validateBuildOrder({ spec: unlocked, crystals: 100, builderIdle: false, footprintValid: true, pathFound: true }),
  ];

  for (const result of cases) assert.equal(result.ok, false);
});

test("construction advances from arrival to one completion", () => {
  const state: ConstructionCycleState = {
    stage: "toSite",
    timer: 0,
    duration: 4,
  };

  assert.equal(advanceConstruction(state, 0, true), "reachedSite");
  assert.equal(state.stage, "building");
  assert.equal(advanceConstruction(state, 2, false), "none");
  assert.equal(constructionProgress(state.timer, state.duration), 0.5);
  assert.equal(advanceConstruction(state, 2.1, false), "completed");
  assert.equal(state.stage, "idle");
  assert.equal(constructionProgress(state.timer, state.duration), 1);
  assert.equal(advanceConstruction(state, 10, false), "none");
});
