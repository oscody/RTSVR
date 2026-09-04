import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTACK_EPSILON,
  ATTACK_TIMER_EPSILON,
  BUILDING_MAX_HEALTH,
  ENEMY_ATTACK_SPECS,
  ENEMY_MAX_HEALTH,
  TURRET_ATTACK_SPEC,
  UNIT_ATTACK_SPECS,
  UNIT_MAX_HEALTH,
  advanceAttackCycle,
  canFriendlyTargetWaveStage,
  canUnitAttack,
  getEnemyAttackSpec,
  getEnemyMaxHealth,
  getUnitAttackSpec,
  isWithinAttackRange,
  resolveDamage,
  shouldAutoAcquireUnitTarget,
  type AttackCycleState,
} from "../src/systems/combatRules.ts";
import { BUILDING_CATALOG } from "../src/systems/buildingCatalog.ts";
import {
  ASTRONAUT_PRODUCTION_SPEC,
  CRAFT_CATALOG,
} from "../src/systems/craftCatalog.ts";
import { DEBUG_SETTINGS_CATALOG } from "../src/systems/debugSettingsCatalog.ts";

test("only astronauts, rovers, and racers can attack", () => {
  assert.equal(canUnitAttack("astronaut"), true);
  assert.equal(canUnitAttack("rover"), true);
  assert.equal(canUnitAttack("racer"), true);
  assert.equal(canUnitAttack("miner"), false);
  assert.equal(canUnitAttack("cargo"), false);
  assert.equal(getUnitAttackSpec("miner"), undefined);
  assert.equal(getUnitAttackSpec("cargo"), undefined);
});

test("alien variants define distinct health and attack power", () => {
  assert.equal(getEnemyMaxHealth("alien"), 80);
  assert.equal(getEnemyMaxHealth("alienDrake"), 60);
  assert.equal(getEnemyMaxHealth("strongAlienMech"), 160);

  assert.ok(getEnemyMaxHealth("alienDrake") < getEnemyMaxHealth("alien"));
  assert.ok(getEnemyMaxHealth("strongAlienMech") > getEnemyMaxHealth("alien"));
  assert.ok(getEnemyAttackSpec("alienDrake").damage > getEnemyAttackSpec("alien").damage);
  assert.ok(getEnemyAttackSpec("strongAlienMech").damage > getEnemyAttackSpec("alien").damage);
});

test("friendly automatic acquisition uses each unit attack range", () => {
  for (const spec of Object.values(UNIT_ATTACK_SPECS)) {
    assert.ok(spec.range < TURRET_ATTACK_SPEC.range);
  }
});

test("friendly units auto-acquire unless constructing", () => {
  assert.equal(shouldAutoAcquireUnitTarget(false, false), true);
  assert.equal(shouldAutoAcquireUnitTarget(true, false), true);
  assert.equal(shouldAutoAcquireUnitTarget(false, true), false);
});

test("friendly combat ignores hidden waiting-wave reserves", () => {
  assert.equal(canFriendlyTargetWaveStage("waiting"), false);
  assert.equal(canFriendlyTargetWaveStage("released"), true);
  assert.equal(canFriendlyTargetWaveStage("marching"), true);
  assert.equal(canFriendlyTargetWaveStage("attacking"), true);
});

test("debug settings catalog exposes combat health and attack power knobs", () => {
  const keys = new Set(DEBUG_SETTINGS_CATALOG.map(({ key }) => key));
  for (const key of [
    "buildingHealthScale",
    "astronautHealth",
    "craftRacerHealth",
    "craftMinerHealth",
    "alienHealthScale",
    "astronautAttackDamage",
    "craftRacerAttackDamage",
    "turretAttackDamage",
  ]) {
    assert.equal(keys.has(key), true);
  }
  assert.equal(UNIT_MAX_HEALTH.astronaut, 75);
  assert.equal(UNIT_MAX_HEALTH.racer, 90);
  assert.equal(UNIT_MAX_HEALTH.miner, 100);
  assert.equal(UNIT_ATTACK_SPECS.astronaut.damage, 8);
  assert.equal(UNIT_ATTACK_SPECS.racer.damage, 12);
  assert.equal(TURRET_ATTACK_SPEC.damage, 18);
});

test("turret cadence can destroy a full-health alien", () => {
  const state: AttackCycleState = {
    timer: 0,
    cadence: TURRET_ATTACK_SPEC.cadence,
  };
  let health = 80;
  for (let shot = 0; shot < 5; shot += 1) {
    const hits = advanceAttackCycle(state, TURRET_ATTACK_SPEC.cadence, true);
    health = resolveDamage(
      health,
      TURRET_ATTACK_SPEC.damage,
      hits,
      "enemy",
    ).remaining;
  }
  assert.equal(health, 0);
});

test("attack range includes the Float32 boundary epsilon", () => {
  assert.equal(isWithinAttackRange(0.29, 0.29), true);
  assert.equal(isWithinAttackRange(0.29 + ATTACK_EPSILON, 0.29), true);
  assert.equal(
    isWithinAttackRange(0.29 + ATTACK_EPSILON + 0.0001, 0.29),
    false,
  );
});

test("attack cadence produces only completed fixed intervals", () => {
  const state: AttackCycleState = { timer: 0, cadence: 1 };
  assert.equal(advanceAttackCycle(state, 0.6, true), 0);
  assert.equal(advanceAttackCycle(state, 0.4, true), 1);
  assert.equal(state.timer, 0);
  assert.equal(advanceAttackCycle(state, 2.2, true), 2);
  assert.ok(Math.abs(state.timer - 0.2) < 0.000001);
  assert.equal(advanceAttackCycle(state, 0.5, false), 0);
  assert.equal(state.timer, 0);

  state.timer = 1 - ATTACK_TIMER_EPSILON / 2;
  assert.equal(advanceAttackCycle(state, 0, true), 1);
  assert.equal(state.timer, 0);
});

test("death and enemy kill occur exactly once at zero health", () => {
  const first = resolveDamage(20, 10, 1, "enemy");
  assert.deepEqual(first, {
    remaining: 10,
    died: false,
    enemyKilled: false,
  });
  const lethal = resolveDamage(first.remaining, 10, 1, "enemy");
  assert.deepEqual(lethal, {
    remaining: 0,
    died: true,
    enemyKilled: true,
  });
  assert.deepEqual(resolveDamage(0, 10, 1, "enemy"), {
    remaining: 0,
    died: false,
    enemyKilled: false,
  });
  assert.equal(resolveDamage(10, 10, 1, "friendly").enemyKilled, false);
  assert.equal(resolveDamage(10, 10, 1, "building").enemyKilled, false);
});

test("the attack-range ladder holds: turret > racer > astronaut > alien", () => {
  // Set deliberately on 2026-09-03 alongside the repricing. The turret keeps the
  // longest reach, the racer was moved up toward it without matching it, and the
  // astronaut gained strictly less than the racer did. A future edit that flips
  // any of these pairs changes what the prices were chosen to buy.
  const turret = TURRET_ATTACK_SPEC.range;
  const racer = UNIT_ATTACK_SPECS.racer.range;
  const astronaut = UNIT_ATTACK_SPECS.astronaut.range;
  const alien = ENEMY_ATTACK_SPECS.alien.range;

  assert.ok(turret > racer, `turret ${turret} must outrange racer ${racer}`);
  assert.ok(racer > astronaut, `racer ${racer} must outrange astronaut ${astronaut}`);
  assert.ok(astronaut > alien, `astronaut ${astronaut} must outrange alien ${alien}`);
});

// ── no explicit-stats audit ────────────────────────────────────────────────
//
// `getUnitMaxHealth`, `getBuildingMaxHealth` and `getEnemyMaxHealth` each end
// in a literal fallback (`?? 100`, `?? 250`, `?? 80`). Those numbers appear in
// no catalog, so a kind that misses its table gets a stat nobody authored — and
// it shows up on the tablet tile looking exactly as real as the rest. This is
// not hypothetical: `?? 250` was mistaken for the turret's true health on
// 2026-09-02, and the turret is actually 240.
//
// The fallbacks stay as a crash guard. These tests prove nothing in play needs
// them, so the invented numbers are unreachable rather than merely unlikely.

test("every unlocked building has an authored max health", () => {
  const unlocked = BUILDING_CATALOG.filter((spec) => !spec.locked);
  // Floor: an empty list would make the loop below assert nothing.
  assert.ok(unlocked.length >= 3, `only ${unlocked.length} unlocked buildings`);
  for (const spec of unlocked) {
    assert.ok(
      Object.hasOwn(BUILDING_MAX_HEALTH, spec.kind),
      `building "${spec.kind}" is unlocked but has no BUILDING_MAX_HEALTH entry, ` +
        "so it would silently take the ?? 250 fallback",
    );
  }
});

test("every producible unit has an authored max health", () => {
  const producible = [
    ...CRAFT_CATALOG.map((spec) => spec.kind),
    ASTRONAUT_PRODUCTION_SPEC.kind,
  ];
  assert.ok(producible.length >= 3, `only ${producible.length} producible kinds`);
  for (const kind of producible) {
    assert.ok(
      Object.hasOwn(UNIT_MAX_HEALTH, kind),
      `unit "${kind}" is producible but has no UNIT_MAX_HEALTH entry, ` +
        "so it would silently take the ?? 100 fallback",
    );
  }
});

test("enemy health and attack tables describe the same roster", () => {
  // Neither table is the source of truth for which enemies exist, so the only
  // check available is that they agree — a kind in one and not the other takes
  // a fallback for whichever it is missing from.
  const kinds = Object.keys(ENEMY_MAX_HEALTH).sort();
  assert.ok(kinds.length >= 3, `only ${kinds.length} enemy kinds`);
  assert.deepEqual(kinds, Object.keys(ENEMY_ATTACK_SPECS).sort());
});

test("every unit that can attack has a complete attack spec", () => {
  const entries = Object.entries(UNIT_ATTACK_SPECS);
  assert.ok(entries.length >= 3, `only ${entries.length} attack specs`);
  for (const [kind, spec] of entries) {
    for (const field of ["damage", "cadence", "range"] as const) {
      assert.ok(
        typeof spec[field] === "number" && spec[field] > 0,
        `${kind}.${field} must be a positive number, got ${spec[field]}`,
      );
    }
  }
});
