import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTACK_EPSILON,
  ATTACK_TIMER_EPSILON,
  TURRET_ATTACK_SPEC,
  UNIT_ATTACK_SPECS,
  UNIT_AUTO_ACQUIRE_RANGE,
  advanceAttackCycle,
  canUnitAttack,
  getEnemyAttackSpec,
  getEnemyMaxHealth,
  getUnitAttackSpec,
  isWithinAttackRange,
  resolveDamage,
  shouldAutoAcquireUnitTarget,
  type AttackCycleState,
} from "../src/systems/combatRules.ts";

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

test("friendly automatic acquisition is shorter than turret range", () => {
  assert.ok(UNIT_AUTO_ACQUIRE_RANGE < TURRET_ATTACK_SPEC.range);
  for (const spec of Object.values(UNIT_ATTACK_SPECS)) {
    assert.ok(UNIT_AUTO_ACQUIRE_RANGE <= spec.range);
  }
});

test("only unselected units that are not constructing auto-acquire", () => {
  assert.equal(shouldAutoAcquireUnitTarget(false, false), true);
  assert.equal(shouldAutoAcquireUnitTarget(true, false), false);
  assert.equal(shouldAutoAcquireUnitTarget(false, true), false);
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
