import { createSystem } from "@iwsdk/core";
import { PERFORMANCE_SAMPLE_SECONDS } from "./constants.ts";
import {
  flushFrameProfile,
  setForceCensus,
  setLiveEntityCount,
  type ForceCensus,
} from "./frameProfiler.js";
import { resolvePerformanceSample } from "./performanceRules.js";
import { Transform } from "@iwsdk/core";
import {
  Building,
  Enemy,
  Health,
  RuntimePerformance,
  Unit,
  WaveUnit,
} from "./state.js";

/**
 * Column order for the profiler's `Roster` line, and the reason it is written
 * out here rather than derived from the catalogs.
 *
 * Deriving would track the catalogs automatically, but it would also make the
 * log's columns move when a catalog entry is commented in or out — and columns
 * that move are exactly what the "print every kind, including zeros" decision
 * exists to prevent. So the list is explicit, and anything NOT on it still gets
 * counted into the total and printed under its own name (see `bump`), which
 * means a newly added kind announces itself in the log instead of disappearing.
 *
 * `command-center` is not in `buildingCatalog.ts` — it is placed by
 * `structures.ts` as the starting base — so it has to be listed by hand.
 * Turrets lead the buildings because they are the count most often being
 * checked, even though the ECS files them as `Building` like any other.
 */
const ALIEN_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ["alien", "walker"],
  ["alienDrake", "drake"],
  ["strongAlienMech", "mech"],
]);
const UNIT_KIND_ORDER = ["miner", "racer", "astronaut"] as const;
const BUILDING_KIND_ORDER = [
  "turret",
  "command-center",
  "hangar",
  "factory",
] as const;

/** Preallocated so the once-per-second census allocates nothing. */
const census: ForceCensus = {
  aliensActive: 0,
  aliensWaiting: 0,
  aliensByKind: new Map(
    [...ALIEN_KIND_LABELS.values()].map((label) => [label, 0] as const),
  ),
  units: 0,
  unitsByKind: new Map(UNIT_KIND_ORDER.map((kind) => [kind, 0] as const)),
  buildings: 0,
  buildingsByKind: new Map(BUILDING_KIND_ORDER.map((kind) => [kind, 0] as const)),
};

/** Zero every known column without dropping it, so the columns stay fixed. */
function resetCounts(counts: Map<string, number>): void {
  for (const kind of counts.keys()) counts.set(kind, 0);
}

/** Count one, adding an unlisted kind as its own column rather than losing it. */
function bump(counts: Map<string, number>, kind: string): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

export class PerformanceSystem extends createSystem({
  diagnostics: { required: [RuntimePerformance] },
  units: { required: [Unit] },
  aliens: { required: [Enemy, WaveUnit] },
  buildings: { required: [Building] },
  // Every entity that owns something in the world. Broad on purpose: this is a
  // LEAK census, and a leak that only shows up in a narrow query is one nobody
  // thought to write a query for.
  transforms: { required: [Transform] },
}) {
  private elapsedSeconds = 0;
  private frameCount = 0;
  private worstFrameSeconds = 0;

  update(delta: number): void {
    const frameSeconds =
      Number.isFinite(delta) && delta > 0 ? delta : 0;
    if (frameSeconds <= 0) return;

    this.elapsedSeconds += frameSeconds;
    this.frameCount += 1;
    this.worstFrameSeconds = Math.max(
      this.worstFrameSeconds,
      frameSeconds,
    );
    if (this.elapsedSeconds < PERFORMANCE_SAMPLE_SECONDS) return;

    const diagnostics = this.queries.diagnostics.entities.values().next()
      .value;
    if (!diagnostics) return;

    let movingEntities = 0;
    census.units = 0;
    resetCounts(census.unitsByKind);
    for (const unit of this.queries.units.entities) {
      if (unit.getValue(Unit, "hasOrder") ?? false) movingEntities += 1;
      // Dead-but-not-yet-reaped entities would otherwise inflate the roster for
      // a frame or two after a death, which reads as a miscount rather than a
      // timing artefact.
      if ((unit.getValue(Health, "current") ?? 0) <= 0) continue;
      census.units += 1;
      bump(census.unitsByKind, unit.getValue(Unit, "kind") ?? "unknown");
    }

    census.aliensActive = 0;
    census.aliensWaiting = 0;
    resetCounts(census.aliensByKind);
    for (const alien of this.queries.aliens.entities) {
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) movingEntities += 1;
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      // The same split the release rules use: a "waiting" alien is a prepared
      // reserve, hidden and non-interactive, and is NOT what `maxActiveAliens`
      // caps. Everything else is on the board and counts against the cap.
      if (alien.getValue(WaveUnit, "stage") === "waiting") {
        census.aliensWaiting += 1;
        continue;
      }
      census.aliensActive += 1;
      const kind = alien.getValue(Enemy, "kind") ?? "alien";
      bump(census.aliensByKind, ALIEN_KIND_LABELS.get(kind) ?? kind);
    }

    census.buildings = 0;
    resetCounts(census.buildingsByKind);
    for (const building of this.queries.buildings.entities) {
      if ((building.getValue(Health, "current") ?? 0) <= 0) continue;
      census.buildings += 1;
      bump(census.buildingsByKind, building.getValue(Building, "kind") ?? "unknown");
    }
    setForceCensus(census);

    setLiveEntityCount(this.queries.transforms.entities.size);

    const sample = resolvePerformanceSample(
      this.elapsedSeconds,
      this.frameCount,
      this.worstFrameSeconds,
    );
    diagnostics.setValue(
      RuntimePerformance,
      "enemiesAlive",
      this.queries.aliens.entities.size,
    );
    diagnostics.setValue(RuntimePerformance, "fps", sample.fps);
    diagnostics.setValue(
      RuntimePerformance,
      "averageFrameMs",
      sample.averageFrameMs,
    );
    diagnostics.setValue(
      RuntimePerformance,
      "worstFrameMs",
      sample.worstFrameMs,
    );
    diagnostics.setValue(
      RuntimePerformance,
      "movingEntities",
      movingEntities,
    );
    diagnostics.setValue(
      RuntimePerformance,
      "revision",
      (diagnostics.getValue(RuntimePerformance, "revision") ?? 0) + 1,
    );

    flushFrameProfile();

    this.elapsedSeconds = 0;
    this.frameCount = 0;
    this.worstFrameSeconds = 0;
  }
}
