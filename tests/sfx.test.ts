import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { SFX_CATALOG, SFX_URLS, type SfxId } from "../src/systems/sfxCatalog.ts";

const src = (p: string): string =>
  readFileSync(new URL(`../src/systems/${p}`, import.meta.url), "utf8");
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const index = (): string =>
  readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("every catalog URL is in the manifest, byte-identical", () => {
  // THE failure this suite exists for. `src` must be the URL, never the
  // manifest key: a key does not resolve, gets fetched as a path, and the dev
  // server answers with index.html — `EncodingError: Unable to decode audio
  // data`, every frame. Measured 2026-08-09, recorded at `constants.ts:382`.
  //
  // It is silent on desktop (the sound simply never plays) and total on device,
  // so nothing short of an assertion catches a typo here.
  const manifest = index();
  for (const url of SFX_URLS) {
    assert.ok(
      manifest.includes(`url: "${url}"`),
      `${url} is in SFX_CATALOG but not in the index.ts manifest`,
    );
    assert.match(
      manifest,
      new RegExp(`url: "${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*\\n\\s*type: AssetType\\.Audio`),
      `${url} must be declared as AssetType.Audio`,
    );
  }
});

test("the bank passes URLs to AudioSource, never catalog keys", () => {
  const sfx = code("sfx.ts");
  // The whole point of the catalog is that one string reaches `src`.
  assert.match(sfx, /src: spec\.url/);
  assert.doesNotMatch(sfx, /src:\s*id\b/);
});

test("every clip is a generated WAV that exists on disk", () => {
  for (const url of SFX_URLS) {
    assert.match(url, /\.wav$/, `${url} must be WAV — compressed formats were silent on Quest`);
    const file = new URL(`../public${url}`, import.meta.url);
    assert.ok(existsSync(file), `${url} is not generated — run: node scripts/generate-audio.mjs`);
    // A RIFF/WAVE header, mono 16-bit PCM at 22050 Hz, per the generator.
    const buf = readFileSync(file);
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(buf.toString("ascii", 8, 12), "WAVE");
    assert.equal(buf.readUInt16LE(20), 1, "must be uncompressed PCM");
    assert.equal(buf.readUInt16LE(22), 1, "must be mono");
    assert.equal(buf.readUInt32LE(24), 22050);
  }
});

test("the generator can render one clip without changing the others", () => {
  // Per-clip seeding is what makes `node scripts/generate-audio.mjs zap`
  // byte-identical to a full run. Without it a partial re-render silently
  // rewrites every later clip, and the diff looks like real change.
  const gen = readFileSync(new URL("../scripts/generate-audio.mjs", import.meta.url), "utf8");
  assert.match(gen, /reseed\(clip\.seed\)/);
  for (const clip of ["sfx-click.wav", "sfx-turret-zap.wav", "sfx-alien-death.wav"]) {
    assert.ok(gen.includes(clip), `${clip} has no recipe in the generator`);
  }
  // Distinct seeds, or two clips share a noise sequence.
  const seeds = [...gen.matchAll(/seed:\s*(\d+)/g)].map((m) => m[1]);
  assert.equal(new Set(seeds).size, seeds.length, "clip seeds must be unique");
});

test("one emitter per clip, built once, never per play", () => {
  const sfx = code("sfx.ts");
  // `createTransformEntity` must appear only in init(). Creating an entity per
  // play is the one thing that cannot survive combat rates.
  const init = /init\(\): void \{[\s\S]*?\n  \}/.exec(sfx)?.[0] ?? "";
  assert.ok(init, "SfxSystem.init not found");
  assert.match(init, /createTransformEntity/);
  const play = /export function playSfx[\s\S]*?\n\}/.exec(sfx)?.[0] ?? "";
  assert.ok(play, "playSfx not found");
  assert.doesNotMatch(play, /createTransformEntity|addComponent/);
});

test("concurrency comes from the engine, not a hand-rolled pool", () => {
  const sfx = code("sfx.ts");
  // PlaybackMode.Overlap + maxInstances gives N voices from ONE source and
  // steals past that (`audio-system.js`, playOverlap) — the pattern every
  // vr_examples case uses, target-practice's SMG at maxInstances: 6 included.
  assert.match(sfx, /maxInstances: spec\.voices/);
  assert.match(sfx, /spec\.voices > 1 \? PlaybackMode\.Overlap : PlaybackMode\.Restart/);
});

test("a play before init is a no-op, never a throw", () => {
  // Audio must never be able to take down a frame. Hooks fire from combat,
  // which runs before the player has necessarily triggered anything.
  const play = /export function playSfx[\s\S]*?\n\}/.exec(code("sfx.ts"))?.[0] ?? "";
  assert.match(play, /if \(!entity\) return;/);
});

test("the cooldown drops, it never queues", () => {
  const play = /export function playSfx[\s\S]*?\n\}/.exec(code("sfx.ts"))?.[0] ?? "";
  assert.match(play, /if \(now - last < spec\.cooldownMs\) return;/);
  // A queue would keep firing after the fight that filled it had ended.
  assert.doesNotMatch(play, /push|queue|setTimeout/);
});

test("catalog numbers are sane", () => {
  for (const [id, spec] of Object.entries(SFX_CATALOG) as [SfxId, (typeof SFX_CATALOG)[SfxId]][]) {
    assert.ok(spec.volume > 0 && spec.volume <= 1, `${id} volume out of range`);
    assert.ok(spec.voices >= 1 && spec.voices <= 8, `${id} voices out of range`);
    assert.ok(spec.cooldownMs >= 0, `${id} cooldown must not be negative`);
  }
  // The click is the one clip that must not layer on itself.
  assert.equal(SFX_CATALOG.click.voices, 1);
});

test("the reset stops audio, like every other subsystem", () => {
  assert.match(code("scenarioReset.ts"), /clearSfx\(\)/);
});

test("the shot sound dispatches on WHO fired, like the VFX does", () => {
  // `applyAttack` is shared by all three attacker paths, aliens included, and
  // `emitAttackVfx` dispatches per attacker internally (`combatEffects.ts`,
  // `shotProfile`). Firing the zap unconditionally played a turret laser for an
  // alien melee strike — audio contradicting the VFX two lines above it.
  //
  // Phase 1 has one shot clip, so aliens are silent rather than wrong. Phase 2
  // replaces this with the full per-type dispatch.
  const combat = code("combat.ts");
  assert.match(
    combat,
    /emitAttackVfx\(attacker, target\);[\s\S]{0,40}if \(!attacker\.hasComponent\(Enemy\)\) playSfx\("turretZap"\);/,
    "the zap must be gated on the attacker not being an alien",
  );
  assert.doesNotMatch(
    combat,
    /\n\s*playSfx\("turretZap"\);/,
    "an ungated zap fires for alien attacks too",
  );
});

test("a death sound means a kill, never a cleanup", () => {
  // `alienDeath` must sit inside destroyTarget's Enemy branch — not on a
  // friendly death, and not on the wave system's disposal of aliens built for
  // an abandoned wave, which are discarded rather than killed.
  const combat = code("combat.ts");
  assert.match(
    combat,
    /traceEntityDestroyed\(target\.index, kindId, Reason\.Killed\);\s*\n\s*playSfx\("alienDeath"\);/,
  );
  assert.doesNotMatch(
    code("wave.ts"),
    /playSfx/,
    "discarded prepared aliens must be silent — nothing killed them",
  );
});

test("generator clips reset every piece of their own state", () => {
  // Lazily creating state in render() (`this.phase ?? 0`) meant a clip rendered
  // twice in one process produced different samples, which quietly breaks the
  // guarantee that a partial re-render matches a full run.
  const gen = readFileSync(new URL("../scripts/generate-audio.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(gen, /this\.\w+ \?\? 0/, "per-clip state must be reset in setup(), not created lazily");
});
