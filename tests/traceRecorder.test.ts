import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("manual dump seals and prints synchronously", () => {
  const trace = source("src/systems/trace.ts");
  const recorder = source("src/systems/traceRecorder.ts");

  assert.match(
    trace,
    /requestDump\(Reason\.ManualDump, note, false\)/,
  );
  assert.match(trace, /if \(accepted\) flushPendingDump\(systemNameFor\)/);
  assert.match(
    recorder,
    /snapshotFilling = collectPostTrigger && SNAPSHOT_POST_EVENTS > 0/,
  );
  assert.match(recorder, /if \(!snapshotFilling\) dumpPending = true/);
});

test("automatic dump retains post-trigger evidence before it is exported", () => {
  const runtime = source("src/systems/traceRuntime.ts");
  const recorder = source("src/systems/traceRecorder.ts");

  assert.match(runtime, /requestDump\(\s*hitch \? Reason\.HitchFrame : Reason\.OtherGap/);
  assert.match(
    recorder,
    /export function requestDump\(\s*reason: number,\s*note = "",\s*collectPostTrigger = true/,
  );
  assert.match(recorder, /snapshotPostRemaining = snapshotFilling \? SNAPSHOT_POST_EVENTS : 0/);
  assert.match(recorder, /if \(snapshotPostRemaining > 0 && target\.writes < target\.capacity\) return/);
});

test("a pending automatic snapshot cannot be restarted by another trigger", () => {
  const recorder = source("src/systems/traceRecorder.ts");

  assert.match(recorder, /if \(snapshotFilling \|\| dumpPending\) \{\s*busyDumps \+= 1;\s*return false;/);
  assert.match(recorder, /busy: number/);
  assert.match(recorder, /\| Busy \$\{report\.busy\}/);
});
