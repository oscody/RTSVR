import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ActionKind, logAction } from "../src/systems/actionLog.ts";

const src = (p: string): string =>
  readFileSync(new URL(`../src/systems/${p}`, import.meta.url), "utf8");

/**
 * Source with comments stripped, for "must NOT contain" assertions.
 *
 * Five times now a `doesNotMatch` has flagged a docblock that names a thing
 * precisely to explain why it is *not* used. Assert on syntax, not vocabulary.
 */
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const capture = (fn: () => void): string[] => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
};

test("actionLog is a leaf — it cannot become the middle of a cycle", () => {
  // Five systems call it, and tablet.ts may not import tutorial.ts
  // (tablet.ts:135). A module at the bottom of the graph is what lets both
  // report without meeting. Same rule as tutorialWaveGate.ts.
  // ZERO imports — stronger than "only trace primitives". Same rule as
  // traceFlags.ts and tutorialWaveGate.ts, and it also means the module is
  // runtime-importable by the stripped-TypeScript test runner with no harness.
  assert.doesNotMatch(code("actionLog.ts"), /^import /m);
});

test("one line per action, with a readable prefix", () => {
  const lines = capture(() => {
    logAction(ActionKind.Tutorial, "active -> retired reason=disabled drill=1");
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[Action\] tutorial active -> retired/);
});

test("a repeated action logs EVERY time — clicking twice is two decisions", () => {
  // Regression, 2026-08-27. This module shipped with a repeat-guard that
  // dropped an unchanged `detail`. In _after_B_level2.log the roster went
  // `turret 0` -> `turret 5`, all player-built, and only THREE
  // `produce build turret` lines survived. Two clicks were deleted, and a
  // swallowed line leaves no gap, so nothing looked wrong.
  const lines = capture(() => {
    logAction(ActionKind.Produce, "build turret");
    logAction(ActionKind.Produce, "build turret");
    logAction(ActionKind.Produce, "build turret");
  });
  assert.deepEqual(lines, [
    "[Action] produce build turret",
    "[Action] produce build turret",
    "[Action] produce build turret",
  ]);
});

test("the sink holds no per-kind state at all", () => {
  // The guard was not merely wrong, it was redundant: every state-kind call
  // site checks its own edge (wasImmersive, wasRetired, next !== current,
  // loggedRestart, the awaiting-start check). Suppress at the source that
  // knows the semantics, never in the sink that cannot tell an action from a
  // state. Asserting on syntax, not vocabulary — the docblock explains the Map
  // it no longer has.
  assert.doesNotMatch(code("actionLog.ts"), /new Map/);
  assert.doesNotMatch(code("actionLog.ts"), /resetActionLog/);
});

test("kinds of different sorts do not suppress each other", () => {
  const lines = capture(() => {
    logAction(ActionKind.Tab, "same");
    logAction(ActionKind.Setting, "same");
  });
  assert.equal(lines.length, 2);
});

test("id 8 is deliberately absent — the dropped wave-stage event", () => {
  // [Profile] already prints `Lvl <n> <stage>` at 1 Hz. The gap in the
  // numbering is the record of that decision.
  const ids = Object.values(ActionKind);
  assert.equal(ids.includes(8 as never), false);
  assert.ok(ids.includes(ActionKind.Tab));
});

test("it follows the build mode, computed locally so the module stays a leaf", () => {
  // Was hardcoded `true` on the reasoning that a session record is not a
  // diagnostic. Turning logging off for playtest builds (backlog item 4) made
  // that a decision the build should make, not the file.
  const actionLog = src("actionLog.ts");
  assert.match(actionLog, /const ACTION_LOG_ENABLED: boolean =/);
  assert.match(actionLog, /VITE_DIAGNOSTICS/);
  assert.match(actionLog, /buildEnv\?\.PROD/);

  // Still ZERO imports — the leaf property is what lets tablet.ts and
  // tutorial.ts both call it when they may not import each other, and what
  // lets the strip-types runner load it with no harness. That is worth more
  // than sharing four lines with traceFlags.
  assert.doesNotMatch(code("actionLog.ts"), /^import /m);

  // ...but it must compute the SAME rule, or a build could be half-quiet.
  const flags = src("traceFlags.ts");
  for (const part of ['VITE_DIAGNOSTICS ?? ""', 'buildEnv?.PROD as boolean | undefined) !== true']) {
    assert.ok(actionLog.includes(part), `actionLog is missing: ${part}`);
    assert.ok(flags.includes(part), `traceFlags is missing: ${part}`);
  }
});

// ── Phase 2/3: the call sites ─────────────────────────────────────────────

test("every planned event has a call site", () => {
  const sites: Array<[string, string]> = [
    ["matchStart.ts", "ActionKind.Xr"],
    ["matchStart.ts", "ActionKind.MatchStart"],
    ["combat.ts", "ActionKind.MatchEnd"],
    ["scenarioReset.ts", "ActionKind.Restart"],
    ["tutorial.ts", "ActionKind.Tutorial"],
    ["tablet.ts", "ActionKind.Setting"],
    ["tablet.ts", "ActionKind.Tab"],
    ["tablet.ts", "ActionKind.Dump"],
    ["interaction.ts", "ActionKind.Order"],
    ["tablet.ts", "ActionKind.Produce"],
    ["tablet.ts", "ActionKind.Cancel"],
  ];
  for (const [file, kind] of sites) {
    assert.match(src(file), new RegExp(kind.replace(".", "\\.")), `${file} must log ${kind}`);
  }
});

test("all eleven planned events are implemented", () => {
  // Three were missing on the first pass — session start, produce and cancel —
  // and the earlier site test passed anyway because it only asserted the nine
  // that had been written. A test that encodes what was done rather than what
  // was agreed cannot notice an omission.
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /ActionKind\.Session/, "session start must be logged at boot");
  const kinds = Object.keys(
    JSON.parse(
      JSON.stringify({
        Session: 1, Xr: 1, MatchStart: 1, MatchEnd: 1, Restart: 1,
        Tutorial: 1, Setting: 1, Tab: 1, Produce: 1, Order: 1, Cancel: 1, Dump: 1,
      }),
    ),
  );
  const everywhere =
    index +
    ["matchStart.ts", "combat.ts", "scenarioReset.ts", "tutorial.ts",
     "tablet.ts", "interaction.ts"].map(src).join("");
  for (const k of kinds) {
    assert.match(everywhere, new RegExp(`ActionKind\\.${k}`), `${k} has no call site`);
  }
});

test("the tutorial reports WHY it went dormant, not just that it did", () => {
  const tutorial = src("tutorial.ts");
  // The 08-27 question verbatim: goDormant has four distinct causes and used to
  // record none, so "the player switched it off" and "the code retired it" were
  // indistinguishable afterwards.
  assert.match(tutorial, /private dormantReason\(\): string/);
  for (const reason of [
    "already-left",
    "disabled",
    "not-immersive",
    "script-complete",
  ]) {
    assert.match(tutorial, new RegExp(`"${reason}"`));
  }
  assert.match(tutorial, /reason=\$\{this\.dormantReason\(\)\}/);
});

test("the tutorial logs once per real transition, not once per frame", () => {
  const tutorial = src("tutorial.ts");
  // goDormant runs EVERY FRAME while dormant and is deliberately idempotent.
  // Logging on entry produced two lines for one event — `disabled` on one
  // frame, `already-left` on the next, as a different branch of update()
  // reached the same call. The fix is to log on the two state changes the
  // function already guards, not on entry.
  const body = /private goDormant[\s\S]*?\n  \}/.exec(tutorial)?.[0] ?? "";
  assert.ok(body, "goDormant not found");

  // Retirement is logged only when the latch actually flips.
  assert.match(body, /const wasRetired = tutorialRequiresRestart\(\);/);
  assert.match(body, /if \(!wasRetired\) \{/);

  // active -> dormant is logged only past the guard that proves it was active.
  const afterGuard = body.slice(
    body.indexOf('if (!(state.getValue(TutorialState, "active") ?? false)) return;'),
  );
  assert.match(afterGuard, /logAction\(/);

  // And nothing logs before the first branch — that was the bug.
  const beforeFirstBranch = body.slice(0, body.indexOf("if (stillHoldingWaves)"));
  assert.doesNotMatch(beforeFirstBranch, /logAction\(/);
});

test("orders log once per click, not once per unit", () => {
  const interaction = src("interaction.ts");
  // issueGroupOrder takes an array; six selected units would be six lines for
  // one decision, and this is the highest-volume event of the set.
  const call = /logAction\(\s*ActionKind\.Order[\s\S]*?\);/.exec(interaction)?.[0] ?? "";
  assert.ok(call, "no order action logged");
  assert.match(call, /eligible\.length/);
  // Must sit outside any per-unit loop.
  assert.doesNotMatch(call, /for \(const/);
});

test("match start records which route released the gate", () => {
  // Three routes reach it — the landing button, the browser pill and a
  // headset-native entry — and on 08-26 they did not behave the same.
  assert.match(src("matchStart.ts"), /startMatch\(via = "unknown"\)/);
  assert.match(src("matchStart.ts"), /via=\$\{via\}/);
});

test("the dump button is reachable and confirms", () => {
  const tablet = src("tablet.ts");
  const html = readFileSync(new URL("../ui/rts-tablet.uikitml", import.meta.url), "utf8");
  assert.match(html, /id="dump-trace"/);
  assert.match(tablet, /traceManualDump\("manual: tablet"\)/);
  // In VR the console is invisible; silence is worse than no button.
  assert.match(tablet, /Trace dumped to console/);
  assert.match(tablet, /Recorder is not running/);
});

test("XR transitions log real edges, not the boot state", () => {
  const start = src("matchStart.ts");
  // visibilityState.subscribe fires immediately with the current value, and at
  // boot that is always NonImmersive — logging an exit unconditionally reported
  // leaving a session never entered, once per page load. Same shape as the
  // tutorial's spurious boot line: an edge log must see a real edge.
  assert.match(start, /let wasImmersive = false;/);
  assert.match(start, /if \(wasImmersive\) logAction\(ActionKind\.Xr, "exit/);
  assert.match(start, /if \(!wasImmersive\) logAction\(ActionKind\.Xr, `enter/);
});

test("every way the match can END is logged — winning included", () => {
  // 2026-08-27: both MatchEnd sites were LOSING paths. A session cleared all
  // six waves and the narrative just stopped — `Lvl 6 stopped | Enemies 0 alive
  // / 116 killed`, command centre standing, no `[Action] match` line.
  //
  // The older site test passed throughout, because it only asked whether
  // combat.ts CONTAINED `ActionKind.MatchEnd`. Same shape as the missed third
  // alien-build site: asserting a file mentions a guard says nothing about the
  // paths that skip it.
  const combat = code("combat.ts");

  // Counting is what catches a fourth path being added. A positional regex
  // cannot: one of the three writes goes through a multi-line IIFE
  // (`setValue(MatchState, "status", (() => { ... })())`), so "look N lines
  // above the write" silently matched only the one write that fits on a line.
  const writes = combat.match(/setValue\(\s*MatchState,\s*"status"/g) ?? [];
  const logs = combat.match(/logAction\(\s*ActionKind\.MatchEnd/g) ?? [];
  assert.equal(
    writes.length,
    3,
    "combat.ts should have exactly 3 terminal status writes; a new one needs a MatchEnd log",
  );
  assert.equal(logs.length, 3, "every terminal status write needs its own MatchEnd log");

  // And each must name its cause — "the match ended" without a reason is the
  // failure this module exists to prevent.
  for (const cause of [
    "command-center-lost",
    "all-friendlies-lost",
    "all-waves-cleared",
  ]) {
    assert.match(combat, new RegExp(cause), `cause=${cause} is not logged`);
  }
});
