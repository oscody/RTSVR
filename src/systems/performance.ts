import { createSystem } from "@iwsdk/core";
import { PERFORMANCE_SAMPLE_SECONDS } from "./constants.ts";
import { flushFrameProfile } from "./frameProfiler.js";
import { resolvePerformanceSample } from "./performanceRules.js";
import {
  Enemy,
  RuntimePerformance,
  Unit,
  WaveUnit,
} from "./state.js";

export class PerformanceSystem extends createSystem({
  diagnostics: { required: [RuntimePerformance] },
  units: { required: [Unit] },
  aliens: { required: [Enemy, WaveUnit] },
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
    for (const unit of this.queries.units.entities) {
      if (unit.getValue(Unit, "hasOrder") ?? false) movingEntities += 1;
    }
    for (const alien of this.queries.aliens.entities) {
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) movingEntities += 1;
    }

    const sample = resolvePerformanceSample(
      this.elapsedSeconds,
      this.frameCount,
      this.worstFrameSeconds,
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
