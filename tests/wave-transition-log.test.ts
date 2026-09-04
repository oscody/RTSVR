import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  logWaveTransition,
  resetWaveTransitionLog,
} from "../src/systems/waveTransitionLog.ts";
import {
  resetResourceLifetimeForTest,
  trackResource,
  type TrackableResource,
} from "../src/systems/resourceLifetime.ts";

class FakeResource implements TrackableResource {
  private listeners: Array<() => void> = [];
  addEventListener(type: string, listener: () => void): void {
    if (type === "dispose") this.listeners.push(listener);
  }
  dispose(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Capture the `[Action]` lines a body emits. */
function captureLog(body: () => void): string[] {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    body();
  } finally {
    console.log = original;
  }
  return captured;
}

const spawn = (count: number): FakeResource[] => {
  const made: FakeResource[] = [];
  for (let i = 0; i < count; i += 1) {
    const resource = new FakeResource();
    trackResource(resource, {
      kind: "geometry",
      scope: "scenario",
      label: "health-bar",
      owner: `Alien_${i}`,
    });
    made.push(resource);
  }
  return made;
};

test("a wave transition is recorded as an action, not inferred from a profile row", () => {
  // Until 2026-09-03 this existed only as the `Lvl N` prefix changing between
  // two once-a-second profile blocks: known to ±1s, carrying no reason, and
  // gone entirely in a diagnostics-off build.
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();
  const lines = captureLog(() => logWaveTransition(2, 3));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[Action\] wave 2 -> 3/);
});

test("the first transition of a match reports no duration", () => {
  // There is no previous wave to time. Reporting one would silently measure
  // however long the player spent on the landing page.
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();
  const [line] = captureLog(() => logWaveTransition(0, 1));
  assert.doesNotMatch(line, /cleared in/);
});

test("later transitions report how long the wave took", () => {
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();
  captureLog(() => logWaveTransition(0, 1));
  const [line] = captureLog(() => logWaveTransition(1, 2));
  assert.match(line, /cleared in \d+s/);
});

test("resource deltas belong to the wave that just ended", () => {
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();

  const wave1 = spawn(11);
  captureLog(() => logWaveTransition(0, 1));

  // Nine die during wave 1; fifteen are prepared for wave 2 in the countdown.
  wave1.splice(0, 9).forEach((r) => r.dispose());
  spawn(15);
  const [line] = captureLog(() => logWaveTransition(1, 2));

  assert.match(line, /created=\+15/, "only the new preparations, not all 26");
  assert.match(line, /disposed=\+9/);
  // 11 spawned - 9 disposed + 15 prepared = 17 live.
  assert.match(line, /scenarioLive=17/);
});

test("a reset re-times the ladder, so wave 1 is not timed from the previous run", () => {
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();
  captureLog(() => logWaveTransition(0, 1));
  captureLog(() => logWaveTransition(1, 2));

  // A restart replays waves 0-6. Without the reset, the first transition of the
  // new run would report the gap since the OLD run's last transition.
  resetWaveTransitionLog();
  const [line] = captureLog(() => logWaveTransition(0, 1));
  assert.doesNotMatch(line, /cleared in/);
});

test("the resource half is omitted, not zeroed, when nothing is tracked", () => {
  // In a diagnostics-off build nothing registers, and `created=+0 disposed=+0`
  // would read as "nothing was created" — which is false, and worse than
  // saying nothing. The wave number and duration must still survive, because
  // that is the half the balance work depends on.
  resetResourceLifetimeForTest();
  resetWaveTransitionLog();
  const [line] = captureLog(() => logWaveTransition(3, 4));
  assert.match(line, /wave 3 -> 4/);
  assert.doesNotMatch(line, /created=|disposed=|scenarioLive=/);
});

test("the transition is logged before the wave number changes", () => {
  // Called after the write, `from` would equal `to` and every line would read
  // "wave 3 -> 3".
  const combat = readFileSync(
    new URL("../src/systems/combat.ts", import.meta.url),
    "utf8",
  );
  const log = combat.indexOf("logWaveTransition(");
  const write = combat.indexOf('source.setValue(WaveSource, "waveNumber", waveNumber)');
  assert.ok(log > 0 && write > 0);
  assert.ok(log < write, "logWaveTransition must precede the setValue");
});

test("both entry points re-time the ladder", () => {
  // A match can begin twice in a session: the start gate, and a restart. Miss
  // either and one run's first wave is timed from the other's.
  for (const file of ["matchStart.ts", "scenarioReset.ts"]) {
    const source = readFileSync(
      new URL(`../src/systems/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /resetWaveTransitionLog\(\)/,
      `${file} must reset the wave timer`,
    );
  }
});
