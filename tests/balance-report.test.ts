import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/balance-report.mjs", import.meta.url).pathname;

/** A synthetic capture: one wave, four seconds, with the shape the real profiler emits. */
const fixture = (
  rows: Array<{ t: number; alive: number; killed: number; turret: number; crystals?: number; mined?: number }>,
): string =>
  rows
    .map(
      (r) =>
        `frameProfiler.ts:629 [Profile] t+${r.t}s | mono 0 frame 0 seq 0 src Profile\n` +
        `Lvl 1 active | FPS 90 | Avg 11.1 | Worst 12.0 | Enemies ${r.alive} alive / ${r.killed} killed | Moving 0\n` +
        `Force alien 0 act 0 wait | unit 1 | bldg 1\n` +
        `Roster walker 0 drake 0 mech 0 | miner 1 racer 0 astronaut 1 | turret ${r.turret} command-center 1 hangar 0 factory 0` +
          (r.crystals === undefined ? "" : ` | crystals ${r.crystals} mined ${r.mined}`),
    )
    .join("\n");

const run = (log: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "rtsvr-balance-"));
  const path = join(dir, "capture.log");
  writeFileSync(path, log);
  return execFileSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
};

test("building units is not counted as losing them", () => {
  // The first version used peak-minus-minimum, so a roster climbing 0 -> 4
  // turrets reported "4 lost". Only a DECREASE is a loss.
  const out = run(
    fixture([
      { t: 1, alive: 5, killed: 0, turret: 0 },
      { t: 2, alive: 5, killed: 0, turret: 2 },
      { t: 3, alive: 5, killed: 0, turret: 4 },
      { t: 4, alive: 0, killed: 5, turret: 4 },
    ]),
  );
  const row = out.split("\n").find((l) => /^  1 /.test(l)) ?? "";
  assert.ok(row, "no wave-1 row");
  assert.match(row, /\s0\s+—?/, `growth was counted as loss: ${row.trim()}`);
});

test("an actual loss is counted", () => {
  const out = run(
    fixture([
      { t: 1, alive: 5, killed: 0, turret: 3 },
      { t: 2, alive: 5, killed: 0, turret: 1 },
      { t: 3, alive: 0, killed: 5, turret: 1 },
    ]),
  );
  const row = out.split("\n").find((l) => /^  1 /.test(l)) ?? "";
  assert.match(row, /\s2\s/, `expected 2 lost, got: ${row.trim()}`);
});

test("the lead metric reports core-loop step 4 honestly", () => {
  // A run that was WON with no attack order must say so loudly — that is the
  // whole point. The victory line is load-bearing: without it this is just an
  // abandoned capture, where zero orders means nobody played rather than
  // "turrets carried it", and the verdict would be a false accusation.
  const base =
    fixture([
      { t: 1, alive: 5, killed: 0, turret: 1 },
      { t: 2, alive: 0, killed: 5, turret: 1 },
    ]) +
    "\nactionLog.ts:159 [Action] match victory cause=all-waves-cleared wave=6 of 6";
  const silent = run(base);
  assert.match(silent, /attack orders issued: 0/);
  assert.match(silent, /NOT SATISFIED/);

  const withOrder = run(
    base + "\nactionLog.ts:141 [Action] order 2 unit(s) -> tile 8,11 attack",
  );
  assert.match(withOrder, /attack orders issued: 1/);
  assert.doesNotMatch(withOrder, /NOT SATISFIED/);
});

test("it names what it cannot measure rather than implying completeness", () => {
  // Crystals and command-centre health are NOT in the capture. The plan
  // originally claimed "everything needed is already in the console logs",
  // which was wrong for both — so the report says so on every run.
  const out = run(fixture([{ t: 1, alive: 0, killed: 0, turret: 0 }]));
  assert.match(out, /NOT MEASURABLE/);
  assert.match(out, /crystals banked/);
  assert.match(out, /command-centre health/);
});

test("a non-gameplay log is reported, not silently empty", () => {
  const out = run("some build output\nno profile blocks here\n");
  assert.match(out, /no \[Profile\] blocks/);
});

test("a restart starts a new match instead of merging into the old one", () => {
  // The 2026-09-03 capture held three matches: the Restart button replays waves
  // 0-6 without a reload, so wave numbers repeat. Treating the file as one
  // match put every replay in the same bucket, which reported clear times of
  // 827s and 1015s and, impossibly, **-3 kills** — the kill counter resets on
  // restart and the report subtracted across the reset.
  const first = fixture([
    { t: 10, alive: 1, killed: 0, turret: 1 },
    { t: 20, alive: 0, killed: 5, turret: 1 },
  ]);
  const second = fixture([
    { t: 40, alive: 2, killed: 0, turret: 1 },
    { t: 50, alive: 0, killed: 3, turret: 1 },
  ]);
  const out = run(
    `actionLog.ts:159 [Action] match awaiting-start -> playing via=xr-session\n${first}\n` +
      `actionLog.ts:159 [Action] restart scenario reset requested\n${second}`,
  );

  assert.match(out, /2 matches in this capture/);
  assert.match(out, /match 1 of 2/);
  assert.match(out, /match 2 of 2/);

  // Assert against the TABLE ROWS, not the whole output. The report echoes the
  // capture's path, and `mkdtemp` suffixes are random — roughly a third of them
  // look like "rtsvr-balance-2TeBVG", which a bare /-\d+/ matches. That made
  // this test fail ~30% of runs for a reason that had nothing to do with the
  // report. A flaky guard is worse than no guard: it teaches you to rerun.
  const rows = out
    .split("\n")
    .filter((line) => /^\s+\d+\s+\d+s\s/.test(line));
  assert.equal(rows.length, 2, `expected one wave row per match:\n${out}`);

  for (const row of rows) {
    // The reset drops killed 5 -> 0. Merged, that subtraction goes negative.
    assert.doesNotMatch(row, /-\d/, `negative count — the reset leaked across matches: ${row}`);
    // Each match keeps its own 10s span rather than spanning the whole capture.
    assert.doesNotMatch(row, /\b\d{3,}s/, `clear time spans the restart: ${row}`);
  }
});

test("an abandoned match is not reported as a run won without commanding units", () => {
  // Restart, then nothing. Zero attack orders here means nobody played, not
  // that turrets carried the run.
  const out = run(
    `actionLog.ts:159 [Action] match awaiting-start -> playing via=xr-session\n` +
      fixture([{ t: 10, alive: 0, killed: 0, turret: 0 }]),
  );
  assert.match(out, /attack orders issued: 0/);
  assert.doesNotMatch(out, /The run was won/);
  assert.match(out, /nothing to conclude/);
});

test("the report shows crystals when the capture has them, and says so when it does not", () => {
  // Logging the balance is only half the fix — a number nothing reads answers
  // nothing. This is the column that separates "chose turrets" from "could not
  // afford anything else".
  const withGems = run(
    fixture([
      { t: 10, alive: 1, killed: 0, turret: 1, crystals: 40, mined: 100 },
      { t: 20, alive: 0, killed: 5, turret: 2, crystals: 10, mined: 160 },
    ]),
  );
  assert.match(withGems, /gems@start/);
  // Banked 40 at the wave's first sample; mined climbed 100 -> 160 during it.
  assert.match(withGems, /\s40\s+60\s/, `expected gems@start 40 and earned 60:\n${withGems}`);
  assert.doesNotMatch(withGems, /crystals banked at wave start/);

  // A capture from before the fields existed must read "?", never a confident
  // 0 — "the player had nothing" and "we did not record it" are different.
  const without = run(
    fixture([
      { t: 10, alive: 1, killed: 0, turret: 1 },
      { t: 20, alive: 0, killed: 5, turret: 2 },
    ]),
  );
  assert.match(without, /\?\s+\?\s/, `expected unknown columns:\n${without}`);
  assert.match(without, /crystals banked at wave start/);
});
