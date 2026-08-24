import { createSystem } from "@iwsdk/core";
import { anyTraceEnabled } from "./traceFlags.js";
import { Reason } from "./traceIds.js";
import { traceManualDump, traceSkipped } from "./trace.js";
import { sweepHandoffs } from "./traceContracts.js";
import {
  clearInteractions,
  sweepInteractions,
  uiButtonTable,
} from "./traceInteraction.js";
import {
  allocationLine,
  runtimeCountersLine,
  runtimeSupportLine,
  updateRuntimeTracing,
} from "./traceRuntime.js";
import { shaderTraceLine } from "./traceShader.js";
import { isTraceRecording } from "./traceRecorder.js";
import { recentExecutionOrder } from "./traceSystemIds.js";

/**
 * The per-frame heartbeat of the trace, and the only part of it that is an ECS
 * system.
 *
 * It runs **last**, after `ProgramChurnSystem`, and that position is the whole
 * design: the deadline sweeps must see the frame every other system has already
 * had its turn in. A handoff published by `MiningSystem` at registration index
 * 32 and consumed by `TabletSystem` at index 16 is legitimately one frame late,
 * and a sweep running in the middle of the frame would fail it every time.
 *
 * It does no work at all when every flag in `traceFlags.ts` is off — it calls
 * `traceSkipped` and returns, which is both the honest record and the thing
 * `tests/trace.test.ts` checks.
 */
export class TraceDiagnosticsSystem extends createSystem({}) {
  private reported = false;

  update(): void {
    if (!anyTraceEnabled() || !isTraceRecording()) {
      traceSkipped(Reason.TutorialDormant);
      return;
    }
    // One report on the first frame, once the renderer and the WebGL context
    // definitely exist. Doing it at install time would print "shader trace not
    // installed" for a context that was about to appear.
    if (!this.reported) {
      this.reported = true;
      this.reportOnce();
    }
    sweepInteractions();
    sweepHandoffs();
    updateRuntimeTracing();
  }

  private reportOnce(): void {
    const parts = [runtimeSupportLine(), shaderTraceLine(), allocationLine()];
    console.log(
      `[Trace] first frame | ${parts.filter(Boolean).join("\n  ")}\n  ` +
        `execution order: ${recentExecutionOrder(0)}`,
    );
  }
}

/**
 * Console handles, so a dump can be asked for by hand from `chrome://inspect`
 * during a headset run without rebuilding.
 *
 * Attached only when something is recording, and only to `window` — nothing in
 * `src/` reads these back, so they cannot become a hidden dependency.
 */
export function exposeTraceConsoleHandles(): void {
  if (typeof window === "undefined" || !isTraceRecording()) return;
  (window as unknown as Record<string, unknown>).rtsvrTrace = {
    dump: (note = "manual") => traceManualDump(note),
    order: (rowsBack = 1) => recentExecutionOrder(rowsBack),
    buttons: () => uiButtonTable(),
    counters: () => runtimeCountersLine(),
    support: () => runtimeSupportLine(),
    shader: () => shaderTraceLine(),
    allocation: () => allocationLine(),
    clearInteractions: () => clearInteractions(Reason.ManualDump),
  };
}
