import assert from "node:assert/strict";
import test from "node:test";

import { getBuildingSpec } from "../src/systems/buildingCatalog.ts";
import {
  ASTRONAUT_PRODUCTION_SPEC,
  CRAFT_CATALOG,
} from "../src/systems/craftCatalog.ts";
import {
  advanceCraftProduction,
  type CraftProductionCycleState,
} from "../src/systems/craftRules.ts";
import {
  BUILD_RATE_MAX_MULTIPLIER,
  BUILD_RATE_PER_EXTRA_BUILDER,
  BUILDER_ASSIGNMENTS_PER_FRAME,
} from "../src/systems/constants.ts";
import {
  advanceSiteConstruction,
  buildRateMultiplier,
  cancelRefund,
  constructionProgress,
  destroyRefund,
  footprintApproaches,
  footprintCells,
  pickCancelTarget,
  queueDisplayPositions,
  validateBuildOrder,
} from "../src/systems/constructionRules.ts";
import type { SiteCycleState } from "../src/systems/constructionRules.ts";

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
    footprintValid: true,
    pathFound: true,
  });

  assert.deepEqual(result, { ok: true, remainingCrystals: 60 });
  assert.equal(spec?.kind, "hangar");
});

// Place-first: an order is placed without selecting a builder, so the absence
// of an idle astronaut must not block validation.
test("placing a building does not require an idle builder", () => {
  const spec = getBuildingSpec("turret");
  assert.equal(
    validateBuildOrder({ spec, crystals: 100, footprintValid: true, pathFound: true }).ok,
    true,
  );
  assert.equal(
    validateBuildOrder({
      spec,
      crystals: 100,
      builderIdle: false,
      footprintValid: true,
      pathFound: true,
    }).ok,
    false,
  );
});

test("invalid construction requests preserve the balance", () => {
  const unlocked = getBuildingSpec("factory");
  const locked = getBuildingSpec("relay");
  const cases = [
    validateBuildOrder({ spec: locked, crystals: 100, footprintValid: true, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 10, footprintValid: true, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 100, footprintValid: false, pathFound: true }),
    validateBuildOrder({ spec: unlocked, crystals: 100, footprintValid: true, pathFound: false }),
    validateBuildOrder({
      spec: unlocked,
      crystals: 100,
      builderIdle: false,
      footprintValid: true,
      pathFound: true,
    }),
  ];

  for (const result of cases) assert.equal(result.ok, false);
});

test("a site with no builders makes no progress", () => {
  const state: SiteCycleState = { stage: "pending", timer: 0, duration: 4 };

  assert.equal(advanceSiteConstruction(state, 2, 0), "none");
  assert.equal(state.stage, "pending");
  assert.equal(state.timer, 0);
});

test("construction advances on the site and completes exactly once", () => {
  const state: SiteCycleState = { stage: "pending", timer: 0, duration: 4 };

  assert.equal(advanceSiteConstruction(state, 2, 1), "none");
  assert.equal(state.stage, "building");
  assert.equal(constructionProgress(state.timer, state.duration), 0.5);
  assert.equal(advanceSiteConstruction(state, 2.1, 1), "completed");
  assert.equal(constructionProgress(state.timer, state.duration), 1);
});

// The bug this whole change exists to kill: two astronauts on one tile used to
// mean two independent timers, two completions, and two buildings for one
// footprint — having charged the player twice. Progress now lives on the site,
// so extra builders can only make the SAME build finish faster.
test("multiple builders speed up one build instead of duplicating it", () => {
  const solo: SiteCycleState = { stage: "pending", timer: 0, duration: 4 };
  const pair: SiteCycleState = { stage: "pending", timer: 0, duration: 4 };

  advanceSiteConstruction(solo, 1, 1);
  advanceSiteConstruction(pair, 1, 2);
  assert.equal(solo.timer, 1);
  assert.equal(pair.timer, 1.6);
  assert.ok(pair.timer > solo.timer);

  // And the pair still only ever reports one completion.
  let completions = 0;
  for (let step = 0; step < 20; step += 1) {
    if (advanceSiteConstruction(pair, 1, 2) === "completed") completions += 1;
  }
  assert.equal(completions, 1);
});

test("extra builders give diminishing returns and are capped", () => {
  assert.equal(buildRateMultiplier(0), 0);
  assert.equal(buildRateMultiplier(1), 1);
  assert.equal(buildRateMultiplier(2), 1 + BUILD_RATE_PER_EXTRA_BUILDER);
  assert.equal(buildRateMultiplier(3), 1 + BUILD_RATE_PER_EXTRA_BUILDER * 2);
  assert.equal(buildRateMultiplier(50), BUILD_RATE_MAX_MULTIPLIER);
  assert.ok(
    buildRateMultiplier(3) - buildRateMultiplier(2) <=
      buildRateMultiplier(2) - buildRateMultiplier(1),
  );
});

// Cancelling an order that never got built is a full refund; deliberately
// scrapping something finished is not. That asymmetry is what keeps placement a
// real decision instead of a free, reversible move.
test("cancel refunds in full and destroy refunds partially", () => {
  const hangar = getBuildingSpec("hangar")!;
  assert.equal(cancelRefund(hangar.cost), hangar.cost);
  assert.ok(destroyRefund(hangar.cost) < hangar.cost);
  assert.ok(destroyRefund(hangar.cost) > 0);
  assert.equal(destroyRefund(0), 0);
  assert.equal(cancelRefund(0), 0);
});

test("builder auto-assignment stays inside a one-search-per-frame budget", () => {
  assert.equal(BUILDER_ASSIGNMENTS_PER_FRAME, 1);
});

// Crafts now need an astronaut to come and work on them, and go faster with
// more of them — the same rule buildings use.
test("craft production is gated on builders and scales with them", () => {
  const idle: CraftProductionCycleState = { timer: 0, duration: 6 };
  assert.equal(advanceCraftProduction(idle, 0 * buildRateMultiplier(0)), "none");
  assert.equal(idle.timer, 0);

  const solo: CraftProductionCycleState = { timer: 0, duration: 6 };
  const pair: CraftProductionCycleState = { timer: 0, duration: 6 };
  advanceCraftProduction(solo, 1 * buildRateMultiplier(1));
  advanceCraftProduction(pair, 1 * buildRateMultiplier(2));
  assert.equal(solo.timer, 1);
  assert.equal(pair.timer, 1.6);
});

// Cancel targets the build an astronaut is actually working on; with nothing
// started it takes the first in the queue; with several under way it takes the
// earliest of those, so repeated presses unwind from the front.
test("cancel targets the active build, else the first queued", () => {
  const queued = [
    { queueOrder: 1, inProgress: false },
    { queueOrder: 2, inProgress: false },
    { queueOrder: 3, inProgress: false },
  ];
  assert.equal(pickCancelTarget(queued)?.queueOrder, 1);

  const oneActive = [
    { queueOrder: 1, inProgress: false },
    { queueOrder: 2, inProgress: true },
    { queueOrder: 3, inProgress: false },
  ];
  assert.equal(pickCancelTarget(oneActive)?.queueOrder, 2);

  const twoActive = [
    { queueOrder: 1, inProgress: false },
    { queueOrder: 3, inProgress: true },
    { queueOrder: 2, inProgress: true },
  ];
  assert.equal(pickCancelTarget(twoActive)?.queueOrder, 2);

  assert.equal(pickCancelTarget([]), null);
});

// The badge numbers what is still WAITING. A claimed site loses its number and
// the rest renumber from 1, so the display never starts at 2.
test("queue badges number only the waiting builds, starting at 1", () => {
  const builds = [
    { queueOrder: 10, inProgress: false },
    { queueOrder: 5, inProgress: true },
    { queueOrder: 7, inProgress: false },
    { queueOrder: 9, inProgress: true },
  ];
  const positions = queueDisplayPositions(builds);

  assert.equal(positions.get(builds[2]), 1); // queueOrder 7, earliest waiting
  assert.equal(positions.get(builds[0]), 2); // queueOrder 10
  assert.equal(positions.has(builds[1]), false); // being built
  assert.equal(positions.has(builds[3]), false); // being built
  assert.equal(positions.size, 2);
});

// Not a preference — a hard requirement. If making an astronaut needed an
// astronaut, losing your last one would leave you unable to build anything
// ever again, with no way to recover. Astronaut production self-builds.
test("astronaut production is exempt from the builder requirement", () => {
  assert.equal(ASTRONAUT_PRODUCTION_SPEC.kind, "astronaut");
  for (const spec of CRAFT_CATALOG) {
    assert.notEqual(
      spec.kind,
      ASTRONAUT_PRODUCTION_SPEC.kind,
      "astronaut must stay out of the builder-requiring craft catalog",
    );
  }
});
