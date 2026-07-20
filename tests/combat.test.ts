import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTACK_EPSILON,
  ATTACK_TIMER_EPSILON,
  advanceAttackCycle,
  isWithinAttackRange,
  resolveDamage,
  type AttackCycleState,
} from "../src/systems/combatRules.ts";

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
