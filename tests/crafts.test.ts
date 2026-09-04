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
    // Cargo and rover are commented out in `craftCatalog.ts`, so the catalog
    // ships two craft. This expectation still listed all four from ~2026-07-30
    // to 2026-08-23, which made `npm test` permanently red — and a suite with a
    // known failure stops being a signal, because every later run had to be
    // read as "1 fail, but is it *the* fail?". Restore the entries here if
    // either craft is uncommented.
    [
      {
        kind: "miner",
        glb: "/gltf/craft/craft_miner_A.glb",
        image: "/images/craft_miner.png",
        duration: 6,
        locked: false,
      },
      {
        kind: "racer",
        glb: "/gltf/craft/craft_racerA.glb",
        image: "/images/craft_racer.png",
        duration: 8,
        locked: false,
      },
    ],
  );
});

test("valid craft production deducts exactly one catalog cost", () => {
  const spec = getCraftSpec("miner");
  assert.ok(spec, "the miner must exist in the catalog");
  const result = validateCraftPurchase({
    spec,
    crystals: 100,
    tileAvailable: true,
  });

  // Derived, not restated: the assertion is "one cost was deducted", which is
  // what the test is named for. A literal here just re-encodes the price.
  assert.deepEqual(result, { ok: true, remainingCrystals: 100 - spec.cost });
});

// Place-first, no producer requirement (decided 2026-08-09). You used to have
// to select a command center, hangar or factory before a craft would validate,
// and clicking a turret poisoned that selection with no way back. Now a craft
// only needs to be affordable and to have an open tile.
test("a craft needs no production building selected or built", () => {
  for (const kind of ["miner", "racer"]) {
    const spec = getCraftSpec(kind);
    assert.deepEqual(
      validateCraftPurchase({
        spec,
        crystals: spec!.cost,
        tileAvailable: true,
      }),
      { ok: true, remainingCrystals: 0 },
    );
  }
});

test("invalid craft requests do not return a new balance", () => {
  const spec = getCraftSpec("racer");
  const locked = spec ? { ...spec, locked: true } : undefined;
  const results = [
    validateCraftPurchase({ spec: undefined, crystals: 100, tileAvailable: true }),
    validateCraftPurchase({ spec: locked, crystals: 100, tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 10, tileAvailable: true }),
    validateCraftPurchase({ spec, crystals: 100, tileAvailable: false }),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal("remainingCrystals" in result, false);
  }
});

test("a blocked selected tile rejects craft production", () => {
  const result = validateCraftPurchase({
    spec: getCraftSpec("racer"),
    crystals: 100,
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
