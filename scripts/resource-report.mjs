// Compare resource lifetime across reset cycles in a saved console capture.
//
//   node scripts/resource-report.mjs <log> [<log2> ...]
//
// ## What this answers that the profile line cannot
//
// A one-second profile row says what exists now. It cannot say whether a
// restart gave everything back, because "created five, disposed five" and
// "nothing happened" look identical in a net total. This reads the
// `[Resources]` snapshots emitted around each reset and compares cycle to
// cycle, which is the only comparison that holds the scenario constant.
//
// ## The two questions, kept apart
//
//   1. Are `scenario` and `temporary` balanced?  -> must be ZERO at teardown.
//   2. Do `pool` and `session` plateau?          -> may be non-zero, must stop
//                                                   growing after warm-up.
//
// A non-zero count is not a leak. Growth on every identical cycle is.
//
// Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-03-Resource-Disposal-Tracking-Plan.md`,
// section H.

import { readFileSync } from "node:fs";

/** The first cycle builds caches and pools; it is never a comparison point. */
const WARMUP_CYCLES = 1;

/** Below this many comparable settled cycles, a trend is not a trend. */
const MIN_COMPARABLE = 3;

const FIELDS = [
  "scenarioOutstanding",
  "temporaryOutstanding",
  "poolOutstanding",
  "sessionOutstanding",
  "rendererGeom",
  "rendererTex",
  "rendererProg",
  "rendererSampleAgeFrames",
  "warmQueued",
  "warmActive",
];

/**
 * Parse `[Resources]` lines, each tagged with the context it landed in.
 *
 * Level and entity count come from the nearest preceding profile block, because
 * the snapshot line itself carries neither — and without them two cycles cannot
 * be shown to be comparable.
 */
const parseSnapshots = (text) => {
  const snapshots = [];
  let level = null;
  let entities = null;
  let heapMin = null;

  for (const line of text.split("\n")) {
    const context = /^Lvl (\d+) /.exec(line);
    if (context) level = Number(context[1]);
    const ents = /\bEnts (\d+)/.exec(line);
    if (ents) entities = Number(ents[1]);
    const heap = /\bHeap \d+mb min (\d+)/.exec(line);
    if (heap) heapMin = Number(heap[1]);

    const match = /\[Resources\] cycle=(\d+) phase=([a-z-]+)(.*)$/.exec(line);
    if (!match) continue;
    const record = {
      cycle: Number(match[1]),
      phase: match[2],
      level,
      entities,
      heapMin,
    };
    for (const field of FIELDS) {
      const value = new RegExp(`\\b${field}=(-?\\d+)`).exec(match[3]);
      record[field] = value ? Number(value[1]) : null;
    }
    snapshots.push(record);
  }
  return snapshots;
};

/** Group by cycle, keeping the LAST snapshot of each phase in that cycle. */
const byCycle = (snapshots) => {
  const cycles = new Map();
  for (const snapshot of snapshots) {
    let entry = cycles.get(snapshot.cycle);
    if (!entry) {
      entry = { cycle: snapshot.cycle };
      cycles.set(snapshot.cycle, entry);
    }
    entry[snapshot.phase] = snapshot;
  }
  return [...cycles.values()].sort((a, b) => a.cycle - b.cycle);
};

/**
 * True when every step from one cycle to the next increased.
 *
 * Deliberately not "the last is bigger than the first": a one-time cache fill
 * followed by a flat line is exactly what a healthy first cycle looks like, and
 * calling that a leak would train everyone to ignore the verdict. Growth means
 * growth *every* time.
 */
const risesEveryStep = (values) => {
  if (values.length < 2) return false;
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i] > values[i - 1])) return false;
  }
  return true;
};

const pad = (value, width) => String(value ?? "?").padStart(width);

const report = (path) => {
  const text = readFileSync(path, "utf8");
  const snapshots = parseSnapshots(text);
  console.log(`\n${path}`);

  if (snapshots.length === 0) {
    console.log("  INSUFFICIENT — no [Resources] snapshots in this capture.");
    console.log("  (A capture from before the reset snapshots landed, or one");
    console.log("   where the app was never restarted.)");
    return;
  }

  const cycles = byCycle(snapshots);

  // ── Per-cycle rows ──────────────────────────────────────────────────────
  console.log(
    `\n  ${"cycle".padEnd(6)}${"lvl".padStart(4)}${"ents".padStart(6)}` +
      `${"scen".padStart(6)}${"temp".padStart(6)}${"pool".padStart(6)}` +
      `${"sess".padStart(6)}${"geom".padStart(7)}${"tex".padStart(5)}` +
      `${"prog".padStart(6)}${"heapMin".padStart(9)}  phases`,
  );
  for (const entry of cycles) {
    // The settled snapshot is the comparison point; fall back to teardown so a
    // truncated capture still shows what it has rather than an empty row.
    const row = entry["post-settled"] ?? entry["post-teardown"] ?? entry["pre-reset"];
    const phases = ["pre-reset", "post-teardown", "post-settled"]
      .filter((phase) => entry[phase])
      .map((phase) => ({ "pre-reset": "P", "post-teardown": "T", "post-settled": "S" })[phase])
      .join("");
    console.log(
      `  ${String(entry.cycle).padEnd(6)}${pad(row.level, 4)}${pad(row.entities, 6)}` +
        `${pad(row.scenarioOutstanding, 6)}${pad(row.temporaryOutstanding, 6)}` +
        `${pad(row.poolOutstanding, 6)}${pad(row.sessionOutstanding, 6)}` +
        `${pad(row.rendererGeom, 7)}${pad(row.rendererTex, 5)}` +
        `${pad(row.rendererProg, 6)}${pad(row.heapMin, 9)}  ` +
        `${phases}${entry["post-settled"] ? "" : "  (no settled snapshot)"}`,
    );
  }

  // ── Verdicts, most serious first ────────────────────────────────────────
  const verdicts = [];
  // Notes qualify the answer; verdicts ARE the answer. Keeping them apart is
  // what lets a capture say "PASS, having excluded one odd cycle" instead of
  // withholding a verdict because it had something to mention.
  const notes = [];

  // 1. FAIL — a scope that must be zero is not. Checked at post-teardown only:
  //    that is the one moment the expectation holds.
  const leaked = cycles.filter((entry) => {
    const teardown = entry["post-teardown"];
    if (!teardown) return false;
    return (
      (teardown.scenarioOutstanding ?? 0) > 0 ||
      (teardown.temporaryOutstanding ?? 0) > 0
    );
  });
  for (const entry of leaked) {
    const teardown = entry["post-teardown"];
    verdicts.push(
      `FAIL cycle=${entry.cycle} — scenario=${teardown.scenarioOutstanding} ` +
        `temporary=${teardown.temporaryOutstanding} outstanding after teardown. ` +
        `See the [ResourceOutstanding] lines that follow it for label and owner.`,
    );
  }

  // 2. WARMUP-STUCK — a settled snapshot taken with work still queued or in
  //    flight is not a settled snapshot, so every comparison using it is soft.
  for (const entry of cycles) {
    const settled = entry["post-settled"];
    if (!settled) continue;
    if ((settled.warmQueued ?? 0) > 0 || (settled.warmActive ?? 0) > 0) {
      verdicts.push(
        `WARMUP-STUCK cycle=${entry.cycle} — queued=${settled.warmQueued} ` +
          `active=${settled.warmActive} at the settled snapshot.`,
      );
    }
  }

  // 3. Cycles measured on different boards prove nothing about each other —
  //    but discarding four agreeing cycles because a fifth differs is a worse
  //    answer than analysing the four. Group by level and use the largest
  //    group, saying plainly what was left out.
  const settledCycles = cycles.filter((entry) => entry["post-settled"]);
  const eligible = settledCycles.filter((entry) => entry.cycle > WARMUP_CYCLES);

  // A cycle missing a phase cannot be compared to a complete one: its
  // `post-teardown` is where the zero-check lives, and without `pre-reset`
  // there is no "before" for the cycle it belongs to.
  const incomplete = eligible.filter(
    (entry) => !entry["post-teardown"] || !entry["pre-reset"],
  );
  for (const entry of incomplete) {
    notes.push(
      `NOTE — cycle ${entry.cycle} is missing ` +
        `${!entry["pre-reset"] ? "pre-reset" : "post-teardown"}; ` +
        `excluded from the comparison.`,
    );
  }
  const complete = eligible.filter((entry) => !incomplete.includes(entry));

  const byLevel = new Map();
  for (const entry of complete) {
    const level = entry["post-settled"].level;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(entry);
  }
  let comparable = complete;
  if (byLevel.size > 1) {
    // Largest first; ties broken by the later level so the choice is stable.
    const groups = [...byLevel.entries()].sort(
      (a, b) => b[1].length - a[1].length || b[0] - a[0],
    );
    const [level, group] = groups[0];
    if (group.length >= MIN_COMPARABLE) {
      comparable = group;
      const dropped = complete.length - group.length;
      notes.push(
        `NOTE — analysing the ${group.length} settled cycles at level ${level}; ` +
          `${dropped} cycle(s) at ${groups
            .slice(1)
            .map(([l]) => `level ${l}`)
            .join(", ")} excluded as not comparable.`,
      );
    } else {
      comparable = [];
      verdicts.push(
        `INCOMPARABLE — settled cycles span levels ` +
          `${[...byLevel.keys()].sort().join(", ")} and no single level has ` +
          `${MIN_COMPARABLE}. Run the same scenario each cycle.`,
      );
    }
  }
  const levels = new Set(comparable.map((e) => e["post-settled"].level));

  // Level alone is a weak test of "same scenario". Two cycles at the same wave
  // with very different rosters were played differently, and their settled
  // totals are not each other's control. Entity count is the cheapest proxy the
  // capture already carries; a wide spread is reported rather than silently
  // treated as a like-for-like comparison.
  const entityCounts = comparable
    .map((e) => e["post-settled"].entities)
    .filter((v) => v !== null);
  if (entityCounts.length >= 2) {
    const low = Math.min(...entityCounts);
    const high = Math.max(...entityCounts);
    if (high - low > Math.max(10, low * 0.1)) {
      notes.push(
        `NOTE — settled entity counts range ${low}-${high} across the compared ` +
          `cycles, so they were not played identically. Section J asks for one ` +
          `fixed action script per cycle; treat any plateau here as soft.`,
      );
    }
  }

  // 4. GROWTH — pool, session or renderer totals rise at every step.
  const trend = (field) =>
    comparable.map((entry) => entry["post-settled"][field]).filter((v) => v !== null);
  // No trend claim below the minimum. With two cycles `risesEveryStep` is just
  // "b > a", so a one-time pool build reads as growth — the 2026-09-04 v3
  // capture reported four GROWTH verdicts from a single step while also saying
  // INSUFFICIENT, which is the report contradicting itself.
  if (comparable.length >= MIN_COMPARABLE) {
    for (const field of [
      "poolOutstanding",
      "sessionOutstanding",
      "rendererGeom",
      "rendererTex",
      "rendererProg",
    ]) {
      const values = trend(field);
      if (risesEveryStep(values)) {
        verdicts.push(
          `GROWTH ${field} rose on every comparable cycle: ${values.join(" -> ")}`,
        );
      }
    }
    const heaps = comparable
      .map((entry) => entry["post-settled"].heapMin)
      .filter((v) => v !== null);
    if (risesEveryStep(heaps)) {
      verdicts.push(
        `GROWTH heap cycle-minimum rose every cycle: ${heaps.join(" -> ")} ` +
          `(quantized, low confidence — supporting evidence, not proof)`,
      );
    }
  }

  // 5. INSUFFICIENT — reported last because it qualifies the others rather
  //    than replacing them. A FAIL from one cycle is still a FAIL.
  if (comparable.length < MIN_COMPARABLE) {
    verdicts.push(
      `INSUFFICIENT — ${comparable.length} comparable settled cycle(s), ` +
        `need ${MIN_COMPARABLE}. Cycle 1 is warm-up and never counts.`,
    );
  }

  console.log("");
  for (const note of notes) console.log(`  ${note}`);
  if (verdicts.length === 0) {
    console.log(
      `  PASS — ${comparable.length} comparable cycles plateau, and every ` +
        `expected-zero scope was zero after teardown.`,
    );
  } else {
    for (const verdict of verdicts) console.log(`  ${verdict}`);
  }

  // ── What this still cannot see ──────────────────────────────────────────
  console.log(
    `\n  NOT COVERED by app counters:\n` +
      `    - SDK, UIKit and AssetManager resources (renderer totals only)\n` +
      `    - external render targets (reported as unavailable, never 0)\n` +
      `    - GPU/VRAM bytes (renderer.info is a trend signal, not a measure)`,
  );
};

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/resource-report.mjs <log> [<log> ...]");
  process.exit(1);
}
for (const path of paths) report(path);
