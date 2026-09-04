import {
  TURRET_ATTACK_SPEC,
  getBuildingMaxHealth,
  getEnemyMaxHealth,
  getUnitAttackSpec,
  getUnitMaxHealth,
  type AttackSpec,
} from "./combatRules.js";
import { DebugSettings, boardState, type DebugSettingKey } from "./state.js";

function settingNumber(key: DebugSettingKey, fallback: number): number {
  return (boardState.debugSettings?.getValue(DebugSettings, key) as number | undefined) ?? fallback;
}

export function currentUnitMaxHealth(kind: string): number {
  if (kind === "astronaut") {
    return Math.round(settingNumber("astronautHealth", getUnitMaxHealth(kind)));
  }
  if (kind === "fighter") {
    return Math.round(settingNumber("craftFighterHealth", getUnitMaxHealth(kind)));
  }
  if (kind === "miner") {
    return Math.round(settingNumber("craftMinerHealth", getUnitMaxHealth(kind)));
  }
  return getUnitMaxHealth(kind);
}

export function currentBuildingMaxHealth(kind: string): number {
  const scale = settingNumber("buildingHealthScale", 1);
  return Math.round(getBuildingMaxHealth(kind) * scale);
}

export function currentEnemyMaxHealth(kind: string, waveHealthMultiplier = 1): number {
  const scale = settingNumber("alienHealthScale", 1);
  return Math.ceil(getEnemyMaxHealth(kind) * waveHealthMultiplier * scale);
}

export function currentUnitAttackSpec(kind: string): AttackSpec | undefined {
  const spec = getUnitAttackSpec(kind);
  if (!spec) return spec;
  if (kind === "astronaut") {
    return {
      ...spec,
      damage: settingNumber("astronautAttackDamage", spec.damage),
      range: settingNumber("astronautAttackRange", spec.range),
    };
  }
  if (kind === "fighter") {
    return {
      ...spec,
      damage: settingNumber("craftFighterAttackDamage", spec.damage),
      range: settingNumber("craftFighterAttackRange", spec.range),
    };
  }
  return spec;
}

export function currentTurretAttackSpec(): AttackSpec {
  return {
    ...TURRET_ATTACK_SPEC,
    damage: settingNumber("turretAttackDamage", TURRET_ATTACK_SPEC.damage),
    range: settingNumber("turretRange", TURRET_ATTACK_SPEC.range),
  };
}
