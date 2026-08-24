/**
 * Observing shader compile and link calls, and being careful about what that
 * measurement actually means.
 *
 * ## What is hooked, and why it is safe
 *
 * Three functions on the **WebGL context itself** — `shaderSource`,
 * `compileShader`, `linkProgram` — plus `attachShader` so a program can be
 * named. That is the public WebGL API, not a Three.js internal: nothing here
 * reaches into `WebGLRenderer`'s private state, and nothing here duplicates
 * `programChurn.ts`, which watches a completely different thing (how often
 * three.js *re-derives* a program, via an accessor on
 * `renderer.properties.get(material).currentProgram`). The two never touch the
 * same object.
 *
 * ## What the numbers mean, and what they do not
 *
 * The duration recorded is **the duration of the API call**, not the driver's
 * total compile cost. On a driver that defers, `compileShader` can return in
 * microseconds and the real work lands later, inside a draw call — which would
 * then show up in `Render`, not here. Every record is labelled "observed API
 * call duration" for that reason.
 *
 * Three things are deliberately NOT done:
 *
 * - **No `gl.finish()`**, and no other forced synchronisation, to make a
 *   timing number look better. Forcing a sync would change the behaviour being
 *   measured, and the resulting figure would describe the probe rather than the
 *   app.
 * - **No status queries.** `getShaderParameter(COMPILE_STATUS)` and
 *   `getProgramParameter(LINK_STATUS)` both force a sync for exactly the same
 *   reason, so compile/link/validate status is reported as *not collected*
 *   rather than collected at the price of a stall. `KHR_parallel_shader_compile`
 *   is probed with `getSupportedExtensions()`, which enables nothing.
 * - **Nothing is compiled that would not have been.** No material define, no
 *   `needsUpdate`, no renderer setting is touched.
 *
 * A slow observed operation preserves a snapshot. It does **not** get declared
 * the cause of the surrounding hitch — `traceRuntime.ts` records it as one
 * signal among several and says so.
 */

import { SHADER_OP_MS, SHADER_TRACE_ENABLED } from "./traceFlags.js";
import { Reason, RuntimeSignal } from "./traceIds.js";
import { traceRuntime } from "./trace.js";
import { isTraceRecording, meters, requestDump } from "./traceRecorder.js";
import { noteShaderOperation } from "./traceRuntime.js";
import { gpuWarmupStatus } from "./gpuWarmup.js";

/** When an operation happened, as far as the app can tell. */
const Phase = {
  Unknown: 0,
  GpuWarmup: 1,
  WaveCountdownPreparation: 2,
  WaveActive: 3,
  OrdinaryGameplay: 4,
} as const;

const PHASE_NAMES: Readonly<Record<number, string>> = {
  0: "unknown",
  1: "gpu-warmup",
  2: "wave-countdown-preparation",
  3: "wave-active",
  4: "ordinary-gameplay",
};

let currentWaveStageId = 0;

/** Pushed in by `WaveSystem` each frame, so a phase can be named. */
export function setShaderPhaseWaveStage(stageId: number): void {
  currentWaveStageId = stageId;
}

function currentPhase(): number {
  if (gpuWarmupStatus().active) return Phase.GpuWarmup;
  if (currentWaveStageId === 1) return Phase.WaveCountdownPreparation;
  if (currentWaveStageId === 2) return Phase.WaveActive;
  return Phase.OrdinaryGameplay;
}

// ---------------------------------------------------------------------------
// Shader identity
// ---------------------------------------------------------------------------

/**
 * A stable hash of a shader's source, and a bounded signature of its defines.
 *
 * The source itself is never retained — a Three.js fragment shader is tens of
 * kilobytes and there are hundreds of them. What is kept is a 32-bit hash (so
 * two compiles of the same variant are recognisably the same) and at most
 * {@link DEFINE_SIGNATURE_LIMIT} characters of `#define` names, which is what
 * actually distinguishes one variant from another.
 */
interface ShaderIdentity {
  hash: number;
  /** 1 = vertex, 2 = fragment, 0 = unknown. */
  stage: number;
  defines: string;
}

const DEFINE_SIGNATURE_LIMIT = 120;
const identityByShader = new WeakMap<object, ShaderIdentity>();
const identityByProgram = new WeakMap<object, ShaderIdentity>();

function hashSource(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** `#define` names only, truncated. Values are noise for identity purposes. */
function defineSignature(source: string): string {
  let signature = "";
  let cursor = 0;
  while (cursor < source.length && signature.length < DEFINE_SIGNATURE_LIMIT) {
    const found = source.indexOf("#define ", cursor);
    if (found < 0) break;
    const start = found + 8;
    let end = start;
    while (end < source.length && !" \t\r\n".includes(source[end])) end += 1;
    signature += (signature ? "," : "") + source.slice(start, end);
    cursor = end;
  }
  return signature.slice(0, DEFINE_SIGNATURE_LIMIT);
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

interface ShaderHost {
  getContext?: () => WebGLRenderingContext | WebGL2RenderingContext | null;
}

interface PatchedContext {
  __rtsvrShaderTraced?: boolean;
  shaderSource?: (shader: object, source: string) => void;
  compileShader?: (shader: object) => void;
  attachShader?: (program: object, shader: object) => void;
  linkProgram?: (program: object) => void;
  getSupportedExtensions?: () => string[] | null;
}

let installed = false;
let parallelCompileAvailable = false;
let compilesObserved = 0;
let linksObserved = 0;
let slowestObservedMs = 0;

/**
 * Wrap the four context methods. Idempotent, and marked on the context itself
 * so a second call — a hot reload, a second renderer — cannot stack hooks.
 */
export function attachShaderTracing(world: unknown): void {
  if (!SHADER_TRACE_ENABLED || installed) return;
  const renderer = (world as { renderer?: ShaderHost })?.renderer;
  const gl = renderer?.getContext?.() as unknown as PatchedContext | null;
  if (!gl || typeof gl.compileShader !== "function") return;
  if (gl.__rtsvrShaderTraced) return;
  gl.__rtsvrShaderTraced = true;
  installed = true;

  // Probe without enabling. `getExtension` would activate the extension and
  // change what three.js's own `isReady` path does; `getSupportedExtensions`
  // only reports.
  const extensions = gl.getSupportedExtensions?.() ?? [];
  parallelCompileAvailable = extensions.includes("KHR_parallel_shader_compile");

  const originalShaderSource = gl.shaderSource!.bind(gl);
  const originalCompile = gl.compileShader!.bind(gl);
  const originalAttach = gl.attachShader!.bind(gl);
  const originalLink = gl.linkProgram!.bind(gl);

  gl.shaderSource = (shader: object, source: string): void => {
    originalShaderSource(shader, source);
    if (!isTraceRecording()) return;
    const started = performance.now();
    // Vertex shaders declare gl_Position; it is the cheapest reliable tell that
    // does not require a status query.
    const stage = source.includes("gl_Position") ? 1 : 2;
    identityByShader.set(shader, {
      hash: hashSource(source),
      stage,
      defines: defineSignature(source),
    });
    meters.shader.add(performance.now() - started);
  };

  gl.compileShader = (shader: object): void => {
    if (!isTraceRecording()) {
      originalCompile(shader);
      return;
    }
    const started = performance.now();
    originalCompile(shader);
    const afterCall = performance.now();
    compilesObserved += 1;
    recordOperation(
      RuntimeSignal.ShaderCompile,
      afterCall - started,
      identityByShader.get(shader),
    );
    // The wrapper's own cost is everything after the call returned, so the
    // reported overhead never includes the work being measured.
    meters.shader.add(performance.now() - afterCall);
  };

  gl.attachShader = (program: object, shader: object): void => {
    originalAttach(program, shader);
    if (!isTraceRecording()) return;
    const identity = identityByShader.get(shader);
    // The fragment shader's defines are the more informative half, so a later
    // attach of a fragment stage wins over an earlier vertex one.
    if (identity && (identity.stage === 2 || !identityByProgram.has(program))) {
      identityByProgram.set(program, identity);
    }
  };

  gl.linkProgram = (program: object): void => {
    if (!isTraceRecording()) {
      originalLink(program);
      return;
    }
    const started = performance.now();
    originalLink(program);
    const afterCall = performance.now();
    linksObserved += 1;
    recordOperation(
      RuntimeSignal.ShaderLink,
      afterCall - started,
      identityByProgram.get(program),
    );
    meters.shader.add(performance.now() - afterCall);
  };
}

function recordOperation(
  signal: number,
  durationMs: number,
  identity: ShaderIdentity | undefined,
): void {
  const at = performance.now();
  noteShaderOperation(at, durationMs);
  if (durationMs > slowestObservedMs) slowestObservedMs = durationMs;
  traceRuntime(
    signal,
    Math.round(durationMs * 100),
    identity?.hash ?? 0,
    currentPhase(),
  );
  if (durationMs < SHADER_OP_MS) return;
  requestDump(
    Reason.ShaderOperationSlow,
    `${signal === RuntimeSignal.ShaderCompile ? "compileShader" : "linkProgram"} ` +
      `observed API-call duration ${durationMs.toFixed(2)}ms ` +
      `(NOT necessarily the driver's total compile cost) | ` +
      `stage ${identity?.stage === 1 ? "vertex" : identity?.stage === 2 ? "fragment" : "unknown"} | ` +
      `hash ${identity?.hash ?? 0} | defines ${identity?.defines ?? "unknown"} | ` +
      `phase ${PHASE_NAMES[currentPhase()]} | ` +
      `KHR_parallel_shader_compile ${parallelCompileAvailable ? "available" : "UNAVAILABLE"} | ` +
      `compile/link/validate status NOT collected (querying it forces a sync)`,
  );
}

/** One line for the periodic report and for dump headers. */
export function shaderTraceLine(): string {
  if (!SHADER_TRACE_ENABLED) return "";
  if (!installed) return "Shader trace NOT installed (no WebGL context found)";
  return (
    `Shader compiles ${compilesObserved} | links ${linksObserved} | ` +
    `slowest observed API call ${slowestObservedMs.toFixed(2)}ms | ` +
    `KHR_parallel_shader_compile ${parallelCompileAvailable ? "available" : "UNAVAILABLE"} | ` +
    `status queries skipped by design`
  );
}

/** True once the context methods are wrapped. Test- and report-facing. */
export function isShaderTracingInstalled(): boolean {
  return installed;
}
