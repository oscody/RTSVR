// Extract per-wave balance outcomes from a saved console capture.
//
//   node scripts/balance-report.mjs <log> [<log2> ...]
//
// ## Why this exists
//
// Every balance knob already ships live in Settings, so tuning is easy. Judging
// the result is not: "did that feel better" was the only readout, so a guess
// that felt fine once got kept. This turns a capture into numbers you can put
// side by side.
//
// ## The lead metric
//
// **Did the player have to command a unit into a fight?** The vision document's
// core loop step 4 is "select combat units and send them to destroy enemy
// soldiers". A run won entirely by turrets skipped a third of the loop, and no
// amount of "it felt fine" makes that balanced.
//
// Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-01-Balancing-Plan.md`.

import { readFileSync } from "node:fs";

/** One second of the profiler's output, already split into its lines. */
const parseBlocks = (text) => {
  const lines = text.split("\n");
  const blocks = [];
  let time = null;
  let current = null;
  for (const line of lines) {
    const stamp = /\[Profile\] t\+([0-9.]+)s/.exec(line);
    if (stamp) {
      time = Number(stamp[1]);
      continue;
    }
    if (/^Lvl \d+ \w+ \| FPS/.test(line)) {
      if (current) blocks.push(current);
      current = { time, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
};

const num = (block, pattern) => {
  for (const line of block.lines) {
    const m = pattern.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
};

const roster = (block) => {
  for (const line of block.lines) {
    if (!line.startsWith("Roster ")) continue;
    const out = {};
    for (const m of line.matchAll(/([a-z-]+) (\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
  }
  return null;
};

/** Player-side things that can be lost. Aliens are counted separately. */
const FRIENDLY = ["miner", "racer", "astronaut", "turret", "command-center"];

/**
 * Split a capture into one segment per match played.
 *
 * A single log routinely holds several: the tablet's Restart button replays
 * waves 0-6 without reloading the page, so wave numbers REPEAT. Before this
 * existed the whole file was treated as one match and every wave bucket mixed
 * all of them together — a 2026-09-03 capture with two restarts reported clear
 * times of 827s and 1015s and, unmistakably, **-3 kills**, because the kill
 * counter resets on restart and the report subtracted across the reset.
 *
 * `restart` is a boundary as much as `awaiting-start -> playing` is: the first
 * is the only line a restart emits, since a reset keeps the match `playing` and
 * never returns to the start gate.
 */
const splitMatches = (text) => {
  const boundary =
    /\[Action\] (?:match awaiting-start -> playing|restart scenario reset requested)/;
  const lines = text.split("\n");
  const segments = [];
  let current = null;
  for (const line of lines) {
    if (boundary.test(line)) {
      if (current) segments.push(current);
      current = { lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) segments.push(current);
  // No boundary at all: an older capture, or one that never started. Treat the
  // whole file as one segment rather than reporting nothing.
  if (segments.length === 0) return [text];
  return segments.map((s) => s.lines.join("\n"));
};

const report = (path) => {
  const whole = readFileSync(path, "utf8");
  const matches = splitMatches(whole);
  if (matches.length === 1) {
    reportMatch(path, matches[0]);
    return;
  }
  console.log(`\n${path}`);
  console.log(`  ${matches.length} matches in this capture (Restart replays the ladder).`);
  matches.forEach((segment, i) => {
    reportMatch(`  --- match ${i + 1} of ${matches.length} ---`, segment);
  });
};

const reportMatch = (path, text) => {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) {
    console.log(`  ${path}: no [Profile] blocks — not a gameplay capture?`);
    return;
  }

  // Actions carry their own timeline; pair each with the wave that was live.
  const actions = [];
  let t = null;
  for (const line of text.split("\n")) {
    const stamp = /\[Profile\] t\+([0-9.]+)s/.exec(line);
    if (stamp) t = Number(stamp[1]);
    const act = /\[Action\] (.*)/.exec(line);
    if (act) actions.push({ time: t, text: act[1].trim() });
  }

  // Group consecutive blocks by wave number.
  const waves = new Map();
  for (const b of blocks) {
    const m = /^Lvl (\d+) (\w+)/.exec(b.lines[0]);
    if (!m) continue;
    const n = Number(m[1]);
    if (!waves.has(n)) waves.set(n, { active: [], countdown: [], stopped: [] });
    waves.get(n)[m[2]]?.push(b);
  }

  console.log(`\n${path}`);
  const outcome = actions.find((a) => /^match (victory|defeat)/.test(a.text));
  console.log(`  outcome: ${outcome ? outcome.text : "session ended mid-match"}`);

  console.log(
    `\n  ${"wave".padEnd(5)}${"clear".padStart(8)}${"killed".padStart(8)}` +
      `${"peak alive".padStart(11)}${"lost".padStart(6)}` +
      `${"gems@start".padStart(11)}${"earned".padStart(8)}  built`,
  );

  let previousRoster = null;
  let gemsSeen = false;
  for (const [n, phases] of [...waves.entries()].sort((a, b) => a[0] - b[0])) {
    const active = phases.active;
    if (active.length === 0) continue;
    const first = active[0];
    const last = active[active.length - 1];
    const clear = last.time !== null && first.time !== null
      ? `${(last.time - first.time).toFixed(0)}s`
      : "?";

    const killedAtEnd = num(last, /Enemies \d+ alive \/ (\d+) killed/) ?? 0;
    const killedAtStart = num(first, /Enemies \d+ alive \/ (\d+) killed/) ?? 0;
    const peakAlive = Math.max(
      ...active.map((b) => num(b, /Enemies (\d+) alive/) ?? 0),
    );

    // Losses: sum of the actual DROPS in each friendly count, sample to sample.
    //
    // NOT peak-minus-minimum, which was the first attempt and counted *growth*
    // as loss — a roster climbing 0 -> 4 turrets reported "4 lost". Only a
    // decrease is a loss, and only summing consecutive decreases distinguishes
    // "built four" from "built four and lost two".
    //
    // Roster is a once-a-second census, not an event log, so a unit built and
    // lost inside the same second is invisible. This is a floor, not an exact
    // count.
    let lost = 0;
    for (const kind of FRIENDLY) {
      let previous = null;
      for (const b of active) {
        const r = roster(b);
        if (!r) continue;
        const now = r[kind] ?? 0;
        if (previous !== null && now < previous) lost += previous - now;
        previous = now;
      }
    }

    // Economy, added 2026-09-03 with the profiler's `crystals`/`mined` fields.
    // This is what separates "the player CHOSE turrets" from "the player could
    // not afford anything else" — two very different balance problems that a
    // roster of 8 turrets and 2 units looks identical under.
    //
    // Older captures have no such fields, so `roster()` returns them undefined
    // and both columns read "?" rather than a confident 0.
    const startRoster = roster(first) ?? {};
    const endRoster = roster(last) ?? {};
    const gemsAtStart =
      startRoster.crystals === undefined ? "?" : String(startRoster.crystals);
    const earned =
      startRoster.mined === undefined || endRoster.mined === undefined
        ? "?"
        : String(endRoster.mined - startRoster.mined);

    const window = actions.filter(
      (a) => a.time !== null && a.time >= first.time && a.time <= last.time,
    );
    const built = window
      .filter((a) => a.text.startsWith("produce "))
      .map((a) => a.text.replace(/^produce (build|craft) /, ""))
      .join(", ");

    console.log(
      `  ${String(n).padEnd(5)}${clear.padStart(8)}` +
        `${String(killedAtEnd - killedAtStart).padStart(8)}` +
        `${String(peakAlive).padStart(11)}${String(lost).padStart(6)}` +
        `${gemsAtStart.padStart(11)}${earned.padStart(8)}  ${built || "—"}`,
    );
    if (startRoster.crystals !== undefined) gemsSeen = true;
    previousRoster = roster(last);
  }

  // ── The lead metric ─────────────────────────────────────────────────────
  const attackOrders = actions.filter((a) => /^order .*attack$/.test(a.text));
  const anyOrder = actions.filter((a) => a.text.startsWith("order "));
  console.log(
    `\n  CORE LOOP STEP 4 — did a commanded unit have to fight?\n` +
      `    attack orders issued: ${attackOrders.length}` +
      `   (of ${anyOrder.length} orders total)`,
  );
  // Only a WON run can skip step 4. An abandoned segment issued no orders
  // because nobody played it, which says nothing about balance — claiming "the
  // run was won without commanding a unit" there is simply false.
  const won = outcome !== undefined && /^match victory/.test(outcome.text);
  if (attackOrders.length === 0 && won) {
    console.log(
      `    >> NOT SATISFIED. The run was won without commanding a unit into a\n` +
        `       fight, so a third of the core loop never happened.`,
    );
  } else if (attackOrders.length === 0) {
    console.log(`    (no orders, and no victory — nothing to conclude)`);
  }

  const finalRoster = previousRoster ?? {};
  const combatUnits = (finalRoster.racer ?? 0) + (finalRoster.astronaut ?? 0);
  console.log(
    `    ended with ${finalRoster.turret ?? 0} turret(s) vs ${combatUnits} combat unit(s)`,
  );

  // ── Gaps ────────────────────────────────────────────────────────────────
  console.log(
    `\n  NOT MEASURABLE from this capture (needs instrumentation):\n` +
      `    - command-centre health           (roster shows a count, not health)\n` +
      `    - kill attribution by killer kind (no trace event carries it)` +
      (gemsSeen
        ? ""
        : `\n    - crystals banked at wave start   (capture predates the` +
          ` profiler's crystal fields)`),
  );
};

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/balance-report.mjs <log> [<log> ...]");
  process.exit(1);
}
for (const p of paths) report(p);
