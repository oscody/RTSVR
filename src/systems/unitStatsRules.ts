/**
 * The shape and wording of a unit's stat line. Pure — no ECS, no catalogs.
 *
 * Split from `unitStats.ts` for the reason the other `*Rules.ts` modules exist:
 * the live values have to come through `debugStatOverrides`, which reads
 * `boardState` and therefore drags in `@iwsdk/core`. Anything importing that
 * cannot be loaded by the strip-types test runner, so the part worth testing —
 * how a missing attack is worded, how the line is composed — would be
 * untestable if it lived beside the lookups.
 */

export interface UnitStats {
  /** Seconds to produce. `duration` in the catalogs. */
  readonly buildSeconds: number;
  /**
   * Damage per hit, or **null** for a unit that does not fight.
   *
   * Null rather than 0 deliberately: `0` renders as "attacks for zero damage",
   * which is a different and wrong claim about the miner.
   */
  readonly damage: number | null;
  /**
   * Seconds between hits, or null for a unit that does not fight.
   *
   * **Resolved but no longer displayed.** The labelled format has no room for
   * it, so a tile shows `Attack: 18` and not the rate behind it — meaning a
   * turret's 18-every-0.75s and a hypothetical 18-every-3s read identically.
   * Kept on the interface because it is real data a future layout may want, and
   * because dropping it would make `damage`'s null-pairing rule meaningless.
   */
  readonly cadence: number | null;
  readonly maxHealth: number;
}

/**
 * One line for a tablet tile: `Build: 3s  Attack: 18  Hp: 250`.
 *
 * Labelled, because `3s · 18 × 0.75s · 250 hp` needed the reader to already
 * know which number was which. Labels cost width, so **cadence was dropped** to
 * pay for them — see the note on {@link UnitStats.cadence}.
 *
 * Two spaces rather than a separator character: at 10px in a 158px box the
 * label text is already doing the work of separating the fields, and every
 * character counts. UIKit drops overflowing children **silently** rather than
 * clipping, so a line that grows too long disappears with no error — which is
 * exactly how the first version of this feature shipped invisible.
 */
export function formatUnitStats(stats: UnitStats): string {
  const attack = stats.damage === null ? "No attack" : `Attack: ${stats.damage}`;
  return `Build: ${stats.buildSeconds}s  ${attack}  Hp: ${stats.maxHealth}`;
}
