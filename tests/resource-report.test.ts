import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/resource-report.mjs", import.meta.url).pathname;

interface SnapshotOptions {
  scen?: number;
  temp?: number;
  pool?: number;
  sess?: number;
  geom?: number;
  tex?: number;
  prog?: number;
  age?: number;
  queued?: number;
  active?: number;
  level?: number;
  ents?: number;
  heapMin?: number;
}

/** One `[Resources]` line, preceded by the profile context the report reads. */
const snapshot = (
  cycle: number,
  phase: "pre-reset" | "post-teardown" | "post-settled",
  o: SnapshotOptions = {},
): string => {
  const {
    scen = 0, temp = 0, pool = 90, sess = 28,
    geom = 180, tex = 37, prog = 53, age = 1,
    queued = 0, active = 0, level = 3, ents = 164, heapMin = 61,
  } = o;
  return (
    `Lvl ${level} active | FPS 90 | Enemies 0 alive / 0 killed | Moving 0\n` +
    `Calls 165 | Objs 1266 | Mesh 774 | Ents ${ents} | Heap 98mb min ${heapMin} | Geom 208\n` +
    `[Resources] cycle=${cycle} phase=${phase} scenarioOutstanding=${scen} ` +
    `temporaryOutstanding=${temp} poolOutstanding=${pool} sessionOutstanding=${sess} ` +
    `rendererGeom=${geom} rendererTex=${tex} rendererProg=${prog} ` +
    `rendererSampleAgeFrames=${age} warmQueued=${queued} warmActive=${active}`
  );
};

/**
 * A whole capture: `count` cycles, each with all three phases.
 *
 * **A live board holds scenario resources.** `pre-reset` and `post-settled`
 * default to 40 outstanding, because health bars and rings exist while the game
 * is running; only `post-teardown` expects zero. Defaulting every phase to zero
 * — the first version of this helper — let a report that checked the wrong
 * phase pass every test, which a mutation caught.
 */
const capture = (
  count: number,
  perCycle: (cycle: number, phase: string) => SnapshotOptions = () => ({}),
): string => {
  const lines: string[] = [];
  for (let cycle = 1; cycle <= count; cycle += 1) {
    for (const phase of ["pre-reset", "post-teardown", "post-settled"] as const) {
      lines.push(
        snapshot(cycle, phase, {
          scen: phase === "post-teardown" ? 0 : 40,
          ...perCycle(cycle, phase),
        }),
      );
    }
  }
  return lines.join("\n");
};

const run = (log: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "rtsvr-resource-"));
  const path = join(dir, "capture.log");
  writeFileSync(path, log);
  return execFileSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
};

test("five flat cycles pass", () => {
  const out = run(capture(5));
  assert.match(out, /PASS/);
  assert.match(out, /4 comparable cycles plateau/);
  // Cycle 1 builds caches and pools, so it is never a comparison point.
  assert.doesNotMatch(out, /GROWTH|FAIL|WARMUP-STUCK|INCOMPARABLE|INSUFFICIENT/);
});

test("a one-time cache increase is shown but not called a leak", () => {
  // The distinction the whole verdict rests on. Cycle 2 fills a cache and then
  // everything is flat — calling that a leak would train everyone to ignore the
  // report, which is worse than not having one.
  // The comparable range must NOT be flat, or this proves nothing: a report
  // using "last > first" would also pass on a flat range. Here cycle 3 fills a
  // cache and then it holds, so last(130) > first(120) while no step-by-step
  // rise exists. Only an every-step rule gets this right.
  const out = run(
    capture(5, (cycle) => ({ pool: cycle === 1 ? 90 : cycle === 2 ? 120 : 130 })),
  );
  assert.match(out, /PASS/);
  assert.doesNotMatch(out, /GROWTH/);
  assert.match(out, /130/, "the increase is still shown for a human to judge");
});

test("growth on every comparable cycle is reported", () => {
  const out = run(capture(5, (cycle) => ({ pool: 90 + cycle * 4 })));
  assert.match(out, /GROWTH poolOutstanding/);
  assert.match(out, /98 -> 102 -> 106 -> 110/);
  assert.doesNotMatch(out, /PASS/);
});

test("a scenario resource surviving teardown is a FAIL, naming the cycle", () => {
  // Set at post-teardown ONLY. The other phases keep their realistic non-zero
  // scenario counts, so a report reading the wrong phase would either miss this
  // or fail every healthy cycle.
  const out = run(
    capture(5, (cycle, phase) =>
      cycle === 3 && phase === "post-teardown" ? { scen: 2 } : {},
    ),
  );
  assert.match(out, /FAIL cycle=3/);
  assert.match(out, /scenario=2/);
  assert.match(out, /\[ResourceOutstanding\] lines/, "must point at the detail");
});

test("a leaked temporary resource fails too, not just scenario", () => {
  // `temporary` is the warm-up scope. The real combat warm-up currently leaks
  // four resources this way, so this path is not hypothetical.
  const out = run(
    capture(5, (cycle, phase) =>
      cycle === 2 && phase === "post-teardown" ? { temp: 4 } : {},
    ),
  );
  assert.match(out, /FAIL cycle=2/);
  assert.match(out, /temporary=4/);
});

test("a settled snapshot taken mid-warm-up is not trusted", () => {
  const out = run(capture(5, (cycle) => (cycle === 4 ? { queued: 3, active: 1 } : {})));
  assert.match(out, /WARMUP-STUCK cycle=4/);
  assert.match(out, /queued=3 active=1/);
});

test("cycles from different levels are incomparable", () => {
  // Two cycles on one board and two on another prove nothing about either.
  // The pool RISES every cycle here on purpose. Without that there is no trend
  // to suppress, and a report that offered verdicts from mismatched data would
  // still pass — which a mutation caught.
  const out = run(
    capture(5, (cycle) => ({ level: cycle <= 3 ? 3 : 5, pool: 90 + cycle * 4 })),
  );
  assert.match(out, /INCOMPARABLE/);
  // Two cycles at each of two levels: neither group reaches the minimum, so
  // there is nothing to fall back to.
  assert.match(out, /span levels/);
  assert.doesNotMatch(
    out,
    /GROWTH/,
    "no trend may be claimed from cycles measured on different boards",
  );
});

test("too few comparable cycles is stated, not guessed at", () => {
  const out = run(capture(2));
  assert.match(out, /INSUFFICIENT/);
  assert.match(out, /1 comparable settled cycle/);
  assert.match(out, /Cycle 1 is warm-up/);
});

test("a FAIL still stands when there are too few cycles to judge a trend", () => {
  // INSUFFICIENT qualifies the trend verdicts; it does not excuse a leak.
  const out = run(
    capture(2, (cycle, phase) =>
      cycle === 2 && phase === "post-teardown" ? { scen: 1 } : {},
    ),
  );
  assert.match(out, /FAIL cycle=2/);
  assert.match(out, /INSUFFICIENT/);
});

test("a cycle missing its settled snapshot is shown, not dropped", () => {
  const lines = [snapshot(1, "pre-reset"), snapshot(1, "post-teardown")];
  for (let cycle = 2; cycle <= 4; cycle += 1) {
    for (const phase of ["pre-reset", "post-teardown", "post-settled"] as const) {
      lines.push(snapshot(cycle, phase));
    }
  }
  const out = run(lines.join("\n"));
  // Falling back to the teardown row keeps the cycle visible; dropping it would
  // silently renumber the comparison and hide that the capture was cut short.
  assert.match(out, /no settled snapshot/);
  assert.match(out, /^\s+1\s/m, "cycle 1 must still appear");
});

test("a truncated capture ends mid-cycle without crashing", () => {
  const out = run(capture(3) + "\n" + snapshot(4, "pre-reset").split("\n")[2]);
  assert.match(out, /^\s+4\s/m, "the partial cycle is listed");
  assert.doesNotMatch(out, /undefined|NaN/);
});

test("a capture with no snapshots says so plainly", () => {
  // Every capture from before Phase 3 looks like this, and so does any session
  // where the player never pressed Restart.
  const out = run("Lvl 1 active | FPS 90\nCalls 165 | Ents 164");
  assert.match(out, /INSUFFICIENT/);
  assert.match(out, /no \[Resources\] snapshots/);
  assert.doesNotMatch(out, /PASS/);
});

test("the report states what app counters cannot see", () => {
  // A reader who takes these numbers for total GPU usage will draw wrong
  // conclusions; the limits belong next to the answer, not in a document.
  const out = run(capture(5));
  assert.match(out, /NOT COVERED/);
  assert.match(out, /SDK, UIKit and AssetManager/);
  assert.match(out, /render targets .*unavailable, never 0/);
  assert.match(out, /trend signal, not a measure/);
});

test("one odd cycle does not discard the ones that agree", () => {
  // The 2026-09-03 v2 capture had five settled cycles: one at level 0 (the
  // tutorial) and four at level 1. Refusing a verdict on all five because one
  // differed threw away four good cycles — a worse answer than analysing them.
  const out = run(
    capture(6, (cycle) => ({ level: cycle === 2 ? 0 : 1 })),
  );
  assert.match(out, /NOTE — analysing the 4 settled cycles at level 1/);
  assert.match(out, /1 cycle\(s\) at level 0 excluded/);
  assert.match(out, /PASS/, "the comparable four should still be judged");
});

test("a trend is still claimed only from the group that was analysed", () => {
  // The excluded cycle must not contribute to a trend either. Level 0 rises
  // steeply, level 1 is flat: the verdict must reflect level 1 only.
  const out = run(
    capture(6, (cycle) =>
      cycle === 2 ? { level: 0, pool: 500 } : { level: 1, pool: 90 },
    ),
  );
  assert.match(out, /NOTE — analysing the 4 settled cycles at level 1/);
  assert.doesNotMatch(out, /GROWTH/, "the excluded cycle must not create a trend");
  // The count in the verdict must equal the count in the note. A report that
  // announced the subset and then analysed everything anyway would still say
  // "no growth" here — but it would say "5 comparable cycles", which is the
  // tell. Prepending a lower value cannot turn a flat series into a rising one,
  // so the count is the only thing that distinguishes the two.
  assert.match(
    out,
    /PASS — 4 comparable cycles/,
    "the verdict must count the analysed group, not everything eligible",
  );
});

test("a cycle missing a phase is excluded from the comparison", () => {
  // Its `post-teardown` is where the zero-check lives; without `pre-reset`
  // there is no "before". Comparing a partial cycle to complete ones invites a
  // PASS built on a cycle that was never fully measured.
  const lines: string[] = [];
  for (let cycle = 1; cycle <= 6; cycle += 1) {
    const phases =
      cycle === 4
        ? (["post-teardown", "post-settled"] as const)
        : (["pre-reset", "post-teardown", "post-settled"] as const);
    for (const phase of phases) {
      lines.push(snapshot(cycle, phase, { scen: phase === "post-teardown" ? 0 : 40 }));
    }
  }
  const out = run(lines.join("\n"));
  assert.match(out, /cycle 4 is missing pre-reset/);
  assert.match(out, /excluded from the comparison/);
});

test("cycles played differently are flagged, not silently compared", () => {
  // Level alone is a weak test of "same scenario" — the plan asks for equal
  // roster and actions too. Entity count is the cheapest proxy the capture
  // already carries.
  const out = run(capture(6, (cycle) => ({ ents: 100 + cycle * 30 })));
  assert.match(out, /settled entity counts range/);
  assert.match(out, /not played identically/);
  assert.match(out, /treat any plateau here as soft/);
});

test("consistently played cycles draw no such note", () => {
  const out = run(capture(6, () => ({ ents: 164 })));
  assert.doesNotMatch(out, /not played identically/);
  assert.match(out, /PASS/);
});

test("no trend is claimed below the minimum comparable cycles", () => {
  // With two cycles, "rose on every step" is just "b > a" — and the first real
  // increase after a lazy pool is built looks exactly like that. The 2026-09-04
  // v3 capture produced four GROWTH verdicts from one step while simultaneously
  // reporting INSUFFICIENT.
  const out = run(capture(3, (cycle) => ({ pool: 37 + cycle * 34 })));
  assert.match(out, /INSUFFICIENT/);
  assert.doesNotMatch(
    out,
    /GROWTH/,
    "a report cannot say 'not enough cycles to judge' and then judge",
  );
  // The numbers are still in the table for a human to read.
  assert.match(out, /105/);
});
