import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (path: string): string =>
  readFileSync(new URL(`../src/systems/${path}`, import.meta.url), "utf8");

// ── Item 2: stop commands and production after the match ends ──────────────

test("gameplay that mutates the board is gated on the match running", () => {
  // Before the fix these had no status check at all, so units kept taking
  // orders and factories kept finishing craft over a decided match.
  for (const file of [
    "interaction.ts",
    "craftProduction.ts",
    "construction.ts",
    "mining.ts",
  ]) {
    assert.match(
      src(file),
      /if \(!matchAcceptsCommands\("[a-z-]+"\)\) return;/,
      `${file} must refuse to act once the match is over`,
    );
  }
});

test("the gate covers both ends and the reset, not just defeat", () => {
  const start = src("matchStart.ts");
  // "playing" excludes awaiting-start, victory, defeat AND restarting — acting
  // on entities a reset is about to dispose is how dangling handles are made.
  assert.match(
    start,
    /export function matchAcceptsCommands[\s\S]*?status === "playing"/,
  );
});

test("commands are gated at the single funnel, not per subscription", () => {
  const interaction = src("interaction.ts");
  // All six gameplay presses route through observeWorldPress, so one gate
  // covers them and none can be added later that misses it.
  assert.equal((interaction.match(/this\.observeWorldPress\(/g) ?? []).length, 6);
  const funnel = /private observeWorldPress[\s\S]*?const corr = beginWorldInteraction/.exec(
    interaction,
  )?.[0] ?? "";
  assert.match(funnel, /if \(!matchAcceptsCommands\("[a-z-]+"\)\) return;/);
});

test("the tablet stays live so Restart still works", () => {
  // The gate must not reach the tablet, or a finished match cannot be restarted.
  assert.doesNotMatch(src("tablet.ts"), /matchAcceptsCommands/);
});

// ── Item 3: make wave spawning fail safely ────────────────────────────────

test("the activation fallback cannot throw out of update", () => {
  const wave = src("wave.ts");
  // Countdown preparation already caught and returned so activation could
  // retry. The retry itself was unguarded: an exception escaped
  // WaveSystem.update, took the frame with it, and left spawnedWaveNumber
  // unset — so the next frame tried again and threw again.
  const fallback = /\} else \{[\s\S]*?resolveWaveSpawns\(spec[\s\S]*?\n    \}/.exec(wave)?.[0] ?? "";
  assert.ok(fallback, "activation fallback not found");
  assert.match(fallback, /try \{/);
  assert.match(fallback, /catch \(error\)/);
});

test("one bad alien does not take the rest of the wave with it", () => {
  const wave = src("wave.ts");
  assert.match(wave, /private buildAlienSafely\(/);
  // Both paths — prepared and fallback — must go through the guard.
  assert.doesNotMatch(
    wave,
    /this\.createPreparedAlien\(spawns\[this\.spawnCursor\]\)/,
    "the prepared path must use buildAlienSafely",
  );
  assert.doesNotMatch(
    wave,
    /for \(const spawn of spawns\) this\.createPreparedAlien\(spawn\)/,
    "the fallback path must use buildAlienSafely",
  );
});

test("a failed wave is still marked spawned, so it cannot loop", () => {
  const wave = src("wave.ts");
  // A short wave is recoverable; a frame loop retrying a throwing wave is not.
  const body = /private spawnWaveIfNeeded[\s\S]*?spawnedWaveNumber", this\.clock\.waveNumber\)/.exec(wave)?.[0] ?? "";
  assert.ok(body, "spawnedWaveNumber is not set after the build block");
});

test("EVERY alien build site is guarded, not just the activation ones", () => {
  const wave = src("wave.ts");
  // The miss this catches: countdown preparation builds most of every wave a
  // few aliens per frame, and its loop was left unguarded when the two
  // activation paths were fixed. `createPreparedAlien` throws outright when the
  // board root is missing, so that was the likeliest throw site of the three.
  const callSites = (wave.match(/this\.createPreparedAlien\(/g) ?? []).length;
  assert.equal(
    callSites,
    1,
    "createPreparedAlien must be called from exactly one place: inside buildAlienSafely",
  );
  const guard = /private buildAlienSafely[\s\S]*?\n  \}/.exec(wave)?.[0] ?? "";
  assert.match(guard, /this\.createPreparedAlien\(/);
  assert.match(guard, /catch \(error\)/);
});

// ── Abandoned wave preparation must not leak aliens ───────────────────────

test("aliens built for an abandoned wave are disposed, not orphaned", () => {
  const wave = src("wave.ts");
  const code = wave
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // Preparation creates REAL entities (`WaveUnit.stage = "waiting"`), a few per
  // frame across the countdown. `resetWavePreparation` cleared the bookkeeping
  // and left them alive — and `completeVictoryIfWaveCleared` counts every enemy
  // with health regardless of stage, so the current wave could never clear.
  assert.match(code, /private preparedAliens: Entity\[\] = \[\];/);
  assert.match(code, /this\.preparedAliens\.push\(alien\);/);

  // The reset must dispose whatever it still owns.
  const reset = /private resetWavePreparation\(\): void \{[\s\S]*?\n  \}/.exec(code)?.[0] ?? "";
  assert.ok(reset, "resetWavePreparation not found");
  assert.match(reset, /this\.disposePreparedAliens\(\);/);

  // Shared AssetManager geometry/materials: dispose() traverse-frees the whole
  // subtree and takes the shared asset with it.
  const disposer = /private disposePreparedAliens\(\): void \{[\s\S]*?\n  \}/.exec(code)?.[0] ?? "";
  assert.ok(disposer, "disposePreparedAliens not found");
  assert.match(disposer, /releaseEntity\(alien\)/);
  assert.doesNotMatch(disposer, /\.dispose\(\)/);
  // Entity indexes are pooled — anything keyed on one must be cleared.
  assert.match(disposer, /clearThreat\(alien\)/);
  assert.match(disposer, /disposeEnemyRangeRing\(alien\)/);
  assert.match(disposer, /detachAlienAnimation\(alien\)/);
  // Nothing killed these, so kill accounting must not move.
  assert.doesNotMatch(disposer, /incrementEnemyKills|enemiesKilled/);
  assert.doesNotMatch(disposer, /Reason\.Killed|Lifecycle\.Killed/);
});

test("activation disowns the prepared aliens BEFORE the reset", () => {
  // resetWavePreparation() is called on the success path too (right after the
  // [WaveBuild] line). Without the disown, the reset would dispose the very
  // wave it just spawned.
  const code = src("wave.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const adopt = code.indexOf("this.adoptPreparedAliens();");
  const reset = code.indexOf("this.resetWavePreparation();", adopt);
  assert.ok(adopt >= 0, "activation never disowns the prepared aliens");
  assert.ok(reset > adopt, "the disown must come before the reset");
  // Disowning must NOT dispose — these are live now.
  const fn = /private adoptPreparedAliens\(\): void \{[\s\S]*?\n  \}/.exec(code)?.[0] ?? "";
  assert.match(fn, /this\.preparedAliens\.length = 0;/);
  assert.doesNotMatch(fn, /releaseEntity|dispose/);
});
