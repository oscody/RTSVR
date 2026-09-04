import {
  currentBuildingMaxHealth,
  currentTurretAttackSpec,
  currentUnitAttackSpec,
  currentUnitMaxHealth,
} from "./debugStatOverrides.js";
import { getBuildingSpec } from "./buildingCatalog.js";
import {
  ASTRONAUT_PRODUCTION_SPEC,
  getCraftSpec,
} from "./craftCatalog.js";
import type { UnitStats } from "./unitStatsRules.js";

/**
 * The stats a player can see on a tablet tile.
 *
 * ## Why this exists rather than four lookups at the call site
 *
 * The numbers live in five places — `buildingCatalog`, `craftCatalog`, an
 * astronaut spec in `constants`, `combatRules`, and the Settings overrides that
 * scale several of them. A tile that reads them itself would need to know which
 * of those apply to which kind, and would get it subtly wrong: a turret's health
 * comes from `BUILDING_MAX_HEALTH`, a fighter's from `UNIT_MAX_HEALTH`, and both
 * are scaled by different Settings knobs.
 *
 * ## Live values, not catalog constants
 *
 * Every field resolves through `debugStatOverrides`, so a tile reflects what the
 * Settings knobs currently say. Reading the raw catalog would make the tablet
 * lie the moment anyone tuned `turretAttackDamage` or `astronautHealth` — and
 * those knobs exist precisely to be tuned during a playtest, which is when
 * someone is most likely to be reading the tile.
 */
/**
 * Stats for anything the player can produce.
 *
 * Returns null for a kind that is not producible, so a caller cannot silently
 * render zeros for something that does not exist.
 */
export function getUnitStats(kind: string): UnitStats | null {
  // Turret is a BUILDING: its health and attack come from different tables than
  // every craft, which is the mistake this module exists to prevent.
  if (kind === "turret") {
    const spec = getBuildingSpec(kind);
    if (!spec) return null;
    const attack = currentTurretAttackSpec();
    return {
      buildSeconds: spec.duration,
      damage: attack.damage,
      cadence: attack.cadence,
      maxHealth: currentBuildingMaxHealth(kind),
    };
  }

  // The astronaut is produced from the command centre, not the craft catalog.
  if (kind === ASTRONAUT_PRODUCTION_SPEC.kind) {
    const attack = currentUnitAttackSpec(kind);
    return {
      buildSeconds: ASTRONAUT_PRODUCTION_SPEC.duration,
      damage: attack?.damage ?? null,
      cadence: attack?.cadence ?? null,
      maxHealth: currentUnitMaxHealth(kind),
    };
  }

  const craft = getCraftSpec(kind);
  if (craft) {
    // The miner has no entry in `UNIT_ATTACK_SPECS` — it does not fight, and
    // null is how a tile knows to print a dash rather than "0 damage", which
    // would read as "attacks for zero" instead of "does not attack".
    const attack = currentUnitAttackSpec(kind);
    return {
      buildSeconds: craft.duration,
      damage: attack?.damage ?? null,
      cadence: attack?.cadence ?? null,
      maxHealth: currentUnitMaxHealth(kind),
    };
  }

  const building = getBuildingSpec(kind);
  if (building) {
    return {
      buildSeconds: building.duration,
      damage: null,
      cadence: null,
      maxHealth: currentBuildingMaxHealth(kind),
    };
  }
  return null;
}
