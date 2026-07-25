export const ATTACK_EPSILON = 0.005;
export const ATTACK_TIMER_EPSILON = 0.0001;

export interface AttackSpec {
  damage: number;
  cadence: number;
  range: number;
}

export const UNIT_ATTACK_SPECS: Readonly<Record<string, AttackSpec>> = {
  astronaut: { damage: 8, cadence: 1.1, range: 0.29 },
  rover: { damage: 15, cadence: 0.9, range: 0.29 },
  racer: { damage: 12, cadence: 0.7, range: 0.29 },
};

export const TURRET_ATTACK_SPEC: Readonly<AttackSpec> = {
  damage: 18,
  cadence: 0.75,
  range: 0.72,
};

export const UNIT_MAX_HEALTH: Readonly<Record<string, number>> = {
  astronaut: 75,
  rover: 120,
  miner: 100,
  cargo: 140,
  racer: 90,
};

export const BUILDING_MAX_HEALTH: Readonly<Record<string, number>> = {
  "command-center": 500,
  hangar: 300,
  factory: 320,
  turret: 240,
};

export const ENEMY_MAX_HEALTH: Readonly<Record<string, number>> = {
  alien: 80,
  alienDrake: 60,
  strongAlienMech: 160,
};

export const ENEMY_ATTACK_SPECS: Readonly<Record<string, AttackSpec>> = {
  alien: { damage: 10, cadence: 1, range: 0.2 },
  alienDrake: { damage: 14, cadence: 0.9, range: 0.2 },
  strongAlienMech: { damage: 18, cadence: 1.1, range: 0.2 },
};

export function canUnitAttack(kind: string): boolean {
  return UNIT_ATTACK_SPECS[kind] !== undefined;
}

export function getUnitAttackSpec(kind: string): AttackSpec | undefined {
  return UNIT_ATTACK_SPECS[kind];
}

export function shouldAutoAcquireUnitTarget(
  _selected: boolean,
  constructionActive: boolean,
): boolean {
  return !constructionActive;
}

export function getUnitMaxHealth(kind: string): number {
  return UNIT_MAX_HEALTH[kind] ?? 100;
}

export function getBuildingMaxHealth(kind: string): number {
  return BUILDING_MAX_HEALTH[kind] ?? 250;
}

export function getEnemyMaxHealth(kind: string): number {
  return ENEMY_MAX_HEALTH[kind] ?? 80;
}

export function getEnemyAttackSpec(kind: string): AttackSpec {
  return ENEMY_ATTACK_SPECS[kind] ?? ENEMY_ATTACK_SPECS.alien;
}

export function isWithinAttackRange(
  distance: number,
  range: number,
): boolean {
  return distance <= range + ATTACK_EPSILON;
}

export interface AttackCycleState {
  timer: number;
  cadence: number;
}

export function advanceAttackCycle(
  state: AttackCycleState,
  delta: number,
  inRange: boolean,
): number {
  if (!inRange) {
    state.timer = 0;
    return 0;
  }
  if (state.cadence <= 0) return 0;
  state.timer += Math.max(0, delta);
  const hits = Math.floor(
    (state.timer + ATTACK_TIMER_EPSILON) / state.cadence,
  );
  if (hits > 0) {
    state.timer = Math.max(0, state.timer - hits * state.cadence);
  }
  return hits;
}

export type DamageTargetType = "enemy" | "friendly" | "building";

export interface DamageResult {
  remaining: number;
  died: boolean;
  enemyKilled: boolean;
}

export function resolveDamageInto(
  result: DamageResult,
  current: number,
  damagePerHit: number,
  hits: number,
  targetType: DamageTargetType,
): void {
  const wasAlive = current > 0;
  result.remaining = Math.max(
    0,
    current - Math.max(0, damagePerHit * hits),
  );
  result.died = wasAlive && result.remaining === 0;
  result.enemyKilled = result.died && targetType === "enemy";
}

export function resolveDamage(
  current: number,
  damagePerHit: number,
  hits: number,
  targetType: DamageTargetType,
): DamageResult {
  const result: DamageResult = {
    remaining: current,
    died: false,
    enemyKilled: false,
  };
  resolveDamageInto(result, current, damagePerHit, hits, targetType);
  return result;
}
