import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

/**
 * The source imports use emitted `.js` specifiers. Build just the recorder's
 * dependency triangle into a disposable directory so these tests exercise the
 * real typed-array snapshot state rather than merely matching source text.
 */
const BUILD_DIR = mkdtempSync(join(tmpdir(), "rtsvr-trace-recorder-test-"));
execFileSync(
  process.execPath,
  [
    join(ROOT_PATH, "node_modules/typescript/bin/tsc"),
    "--target",
    "ES2020",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--skipLibCheck",
    "--outDir",
    BUILD_DIR,
    "src/systems/traceFlags.ts",
    "src/systems/traceIds.ts",
    "src/systems/traceRecorder.ts",
  ],
  { cwd: ROOT_PATH, stdio: "pipe" },
);

const ids = await import(pathToFileURL(join(BUILD_DIR, "traceIds.js")).href);

/**
 * Both variants are built by rewriting the compiled flags module, and NEITHER
 * reads the shipped values.
 *
 * That symmetry is the point. These tests are about the recorder's dump
 * behaviour, which has to hold whatever `traceFlags.ts` happens to be set to on
 * the branch — and the branch legitimately ships with every flag off while an
 * A/B control run is being captured. Importing the real module here made seven
 * of these tests fail the moment the flags were flipped for that run: a
 * shipping configuration switch was silently deciding whether the test suite
 * was green, which is exactly the coupling a behaviour test must not have.
 */
const enabledFlagsPath = join(BUILD_DIR, "traceFlags.enabled.js");
const enabledRecorderPath = join(BUILD_DIR, "traceRecorder.enabled.js");
writeFileSync(
  enabledFlagsPath,
  readFileSync(join(BUILD_DIR, "traceFlags.js"), "utf8").replace(
    /export const ([A-Z_]+) = false;/g,
    "export const $1 = true;",
  ),
);
writeFileSync(
  enabledRecorderPath,
  readFileSync(join(BUILD_DIR, "traceRecorder.js"), "utf8").replace(
    'from "./traceFlags.js";',
    'from "./traceFlags.enabled.js";',
  ),
);
const recorder = await import(pathToFileURL(enabledRecorderPath).href);

const disabledFlagsPath = join(BUILD_DIR, "traceFlags.disabled.js");
const disabledRecorderPath = join(BUILD_DIR, "traceRecorder.disabled.js");
writeFileSync(
  disabledFlagsPath,
  readFileSync(join(BUILD_DIR, "traceFlags.js"), "utf8").replace(
    /export const ([A-Z_]+) = true;/g,
    "export const $1 = false;",
  ),
);
writeFileSync(
  disabledRecorderPath,
  readFileSync(join(BUILD_DIR, "traceRecorder.js"), "utf8").replace(
    'from "./traceFlags.js";',
    'from "./traceFlags.disabled.js";',
  ),
);
const disabledRecorder = await import(
  pathToFileURL(disabledRecorderPath).href,
);

const { Reason, TraceKind } = ids;
const NAME_FOR_SYSTEM = (id: number): string => `System${id}`;

after(() => {
  recorder.disposeTraceRecorder();
  rmSync(BUILD_DIR, { recursive: true, force: true });
});

function resetRecorder(): void {
  recorder.disposeTraceRecorder();
  assert.equal(recorder.installTraceRecorder(), true);
}

function decision(id: number): void {
  recorder.recordEvent(
    TraceKind.Decision,
    id,
    0,
    0,
    0,
    Reason.None,
    0,
    0,
    performance.now(),
  );
}

function capturedConsole<T>(action: () => T): { result: T; output: string[] } {
  const original = console.log;
  const output: string[] = [];
  console.log = (value?: unknown) => output.push(String(value));
  try {
    return { result: action(), output };
  } finally {
    console.log = original;
  }
}

function printAutomatic(): string {
  const printed = capturedConsole(() => recorder.flushPendingDump(NAME_FOR_SYSTEM));
  assert.equal(printed.output.length, 1);
  return printed.output[0];
}

function sequenceFor(output: string, first: number, last: number): number[] {
  const lines = output.split("\n");
  const idsInOutput = lines
    .map((line) => / DECISION id=(\d+) = 0/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return idsInOutput.filter((id) => id >= first && id <= last);
}

test("automatic dump keeps exactly 64 pre-trigger events, its trigger, and post-trigger events in order", () => {
  resetRecorder();
  for (let id = 1; id <= 70; id += 1) decision(id);

  assert.equal(recorder.requestDump(Reason.HitchFrame, "runtime evidence"), true);
  for (let id = 71; id <= 73; id += 1) decision(id);
  assert.equal(
    recorder.sealSnapshotIfTimedOut(performance.now() + 2_000),
    true,
  );

  const output = printAutomatic();
  assert.match(output, /trigger hitch frame at mono \d+\.\d frame -1 seq 71 \| events 68 \| runtime evidence/);
  assert.deepEqual(sequenceFor(output, 1, 73), Array.from({ length: 67 }, (_, index) => index + 7));
  const triggerIndex = output.indexOf(" TRIGGER reason=hitch frame");
  assert.ok(triggerIndex > output.indexOf(" DECISION id=70 = 0"));
  assert.ok(triggerIndex < output.indexOf(" DECISION id=71 = 0"));
});

test("automatic dump seals after 64 post-trigger events and never elides its trigger", () => {
  resetRecorder();
  for (let id = 1; id <= 64; id += 1) decision(id);
  assert.equal(recorder.requestDump(Reason.OtherGap, "other gap evidence"), true);
  for (let id = 65; id <= 128; id += 1) decision(id);

  assert.equal(recorder.hasPendingDump(), true);
  const output = printAutomatic();
  assert.match(output, /\| events 129 \| other gap evidence/);
  assert.equal((output.match(/ TRIGGER reason=Other gap/g) ?? []).length, 1);
  assert.deepEqual(sequenceFor(output, 1, 128), Array.from({ length: 128 }, (_, index) => index + 1));

  const report = recorder.flushTraceCost();
  assert.ok(report);
  assert.equal(report.dumps, 1);
  assert.ok(report.dumpMs >= 0);
});

test("the two-second automatic timeout seals a quiet snapshot when a frame arrives without a trace event", () => {
  resetRecorder();
  decision(1);
  assert.equal(recorder.requestDump(Reason.LongTaskOverlap, "quiet capture"), true);
  assert.equal(recorder.sealSnapshotIfTimedOut(performance.now() + 1_999), false);
  assert.equal(recorder.hasPendingDump(), false);
  // No `recordEvent` call occurs here: the next frame alone checks the timeout.
  recorder.beginTraceFrame(performance.now() + 2_000);
  assert.equal(recorder.hasPendingDump(), true);
  const output = printAutomatic();
  assert.match(output, /\| events 2 \| quiet capture/);
});

test("a busy automatic trigger cannot replace an active snapshot and increments Busy", () => {
  resetRecorder();
  decision(1);
  assert.equal(recorder.requestDump(Reason.HitchFrame, "first evidence"), true);
  assert.equal(recorder.requestDump(Reason.OtherGap, "replacement evidence"), false);

  const report = recorder.flushTraceCost();
  assert.ok(report);
  assert.equal(report.busy, 1);

  assert.equal(recorder.sealSnapshotIfTimedOut(performance.now() + 2_000), true);
  const output = printAutomatic();
  assert.match(output, /first evidence/);
  assert.doesNotMatch(output, /replacement evidence/);
});

test("a manual dump prints immediately, labels the header, and reports its duration and count", () => {
  resetRecorder();
  decision(41);

  const printed = capturedConsole(() =>
    recorder.printManualDump("operator smoke test", NAME_FOR_SYSTEM),
  );
  assert.equal(printed.result, true);
  assert.equal(printed.output.length, 1);
  assert.match(printed.output[0], /trigger manual dump at mono \d+\.\d frame -1 seq 1 \| events 1 \| operator smoke test/);
  assert.match(printed.output[0], / DECISION id=41 = 0/);

  const report = recorder.flushTraceCost();
  assert.ok(report);
  assert.equal(report.dumps, 1);
  assert.ok(report.dumpMs >= 0);
});

test("a manual dump works during automatic collection without altering that snapshot", () => {
  resetRecorder();
  decision(1);
  assert.equal(recorder.requestDump(Reason.HitchFrame, "automatic evidence"), true);
  decision(2);

  const manual = capturedConsole(() =>
    recorder.printManualDump("while automatic", NAME_FOR_SYSTEM),
  );
  assert.equal(manual.result, true);
  assert.match(manual.output[0], /while automatic/);

  // The original automatic capture still owns the snapshot; it cannot be
  // replaced, and its own header/evidence remain intact when finally printed.
  assert.equal(recorder.requestDump(Reason.OtherGap, "would replace"), false);
  assert.equal(recorder.sealSnapshotIfTimedOut(performance.now() + 2_000), true);
  const automatic = printAutomatic();
  assert.match(automatic, /automatic evidence/);
  assert.doesNotMatch(automatic, /while automatic/);
  assert.doesNotMatch(automatic, /would replace/);
  assert.deepEqual(sequenceFor(automatic, 1, 2), [1, 2]);
});

test("manual dump returns false when tracing is unavailable or printing fails", () => {
  recorder.disposeTraceRecorder();
  assert.equal(recorder.printManualDump("unavailable", NAME_FOR_SYSTEM), false);

  resetRecorder();
  const original = console.log;
  console.log = () => {
    throw new Error("console unavailable");
  };
  try {
    assert.equal(recorder.printManualDump("cannot print", NAME_FOR_SYSTEM), false);
  } finally {
    console.log = original;
  }
});

test("the diagnostics-disabled path performs no optional recorder work", () => {
  assert.equal(disabledRecorder.installTraceRecorder(), false);
  assert.equal(disabledRecorder.isTraceRecording(), false);
  disabledRecorder.recordEvent(
    TraceKind.Decision,
    1,
    0,
    0,
    0,
    Reason.None,
    0,
    0,
    performance.now(),
  );
  disabledRecorder.beginTraceFrame();
  assert.equal(disabledRecorder.requestDump(Reason.HitchFrame, "disabled"), false);
  assert.equal(disabledRecorder.printManualDump("disabled", NAME_FOR_SYSTEM), false);
  assert.equal(disabledRecorder.flushTraceCost(), null);
  disabledRecorder.disposeTraceRecorder();
});

test("WaveSystem keeps skipped execution status without recorder-event spam", () => {
  const trace = source("src/systems/trace.ts");
  const wave = source("src/systems/wave.ts");

  assert.match(trace, /traceSkipped\(reason: number, recordReason = true\)/);
  assert.match(trace, /if \(slot >= 0\) recordSystemSkipped\(slot\)/);
  assert.match(wave, /private traceExpectedSkip\(reason: number\)/);
  assert.match(wave, /traceSkipped\(reason, changed\)/);
});
