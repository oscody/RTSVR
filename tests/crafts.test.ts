import assert from "node:assert/strict";
import test from "node:test";

import { CRAFT_CATALOG, getCraftSpec } from "../src/systems/craftCatalog.ts";
import {
  advanceCraftProduction,
  craftProductionProgress,
  validateCraftPurchase,
} from "../src/systems/craftRules.ts";
import type { CraftProductionCycleState } from "../src/systems/craftRules.ts";

test("craft catalog exposes every model and tablet image", () => {
  assert.deepEqual(
    CRAFT_CATALOG.map(({ kind, glb, image, duration, locked }) => ({
      kind,
      glb,
      image,
      duration,
      locked,
    })),
    [
      {
        kind: "cargo",
        glb: "/gltf/craft/craft_cargoA.glb",
        image: "/images/craft_cargoA.png",
        duration: 5,
        locked: false,
      },
      {
        kind: "miner",
        glb: "/gltf/craft/craft_cargoA_A.glb",
        image: "/images/craft_miner.png",
        duration: 6,
        locked: false,
      },
      {
        kind: "racer",
        glb: "/gltf/craft/craft_racer.glb",
        image: "/images/craft_racer.png",
        duration: 8,
        locked: false,
      },
      {
        kind: "rover",
        glb: "/gltf/craft/rover.glb",
        image: "/images/rover.png",
        duration: 4,
        locked: false,
      },
    ],
  );
});

test("valid craft production deducts exactly one catalog cost", () => {
  const spec = getCraftSpec("miner");
  const result = validateCraftPurchase({
    spec,
    crystals: 100,
    buildingKind: "hangar",
    tileAvailable: true,
  });

  assert.deepEqual(result, { ok: true, remainingCrystals: 40 });
});

test("command center, hangar, and factory can produce crafts", () => {
  const spec = getCraftSpec("rover");
  for (const buildingKind of ["command-center", "hangar", "factory"]) {
    assert.deepEqual(
      validateCraftPurchase({
        spec,
        crystals: 40,
        buildingKind,
        tileAvailable: true,
      }),
      { ok: true, remainingCrystals: 0 },
    );
  }
});

test("invalid craft requests do not return a new balance", () => {
  const spec = getCraftSpec("cargo");
  const locked = spec ? { ...spec, locked: true } : undefined;
  const results = [
    validateCraftPurchase({ spec: undefined, crystals: 100, buildingKind: "hangar", tileAvailable: true }),
    validateCraftPurchase({ spec: locked, crystals: 100, buildingKind: "hangar", tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 100, buildingKind: null, tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 100, buildingKind: "turret", tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 10, buildingKind: "hangar", tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 100, buildingKind: "hangar", tileAvailable: false }),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal("remainingCrystals" in result, false);
  }
});

test("a blocked selected tile rejects craft production", () => {
  const result = validateCraftPurchase({
    spec: getCraftSpec("rover"),
    crystals: 100,
    buildingKind: "factory",
    tileAvailable: false,
  });
  assert.deepEqual(result, { ok: false, error: "That tile is blocked" });
});

test("craft production waits for its full duration", () => {
  const state: CraftProductionCycleState = { timer: 0, duration: 4 };
  assert.equal(advanceCraftProduction(state, 1.5), "none");
  assert.equal(craftProductionProgress(state.timer, state.duration), 0.375);
  assert.equal(advanceCraftProduction(state, 2.4), "none");
  assert.equal(advanceCraftProduction(state, 0.1), "completed");
  assert.equal(state.timer, 4);
  assert.equal(craftProductionProgress(state.timer, state.duration), 1);
  assert.equal(advanceCraftProduction(state, 1), "none");
});
