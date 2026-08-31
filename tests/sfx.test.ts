import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  AMBIENCE_IDS,
  SFX_CATALOG,
  SFX_URLS,
  type SfxId,
  type SfxSpec,
} from "../src/systems/sfxCatalog.ts";

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
  assert.match(sfx, /spec\.voices > 1$/m);
  assert.match(sfx, /PlaybackMode\.Overlap/);
  // Loops take Ignore, so a second start does not restart a running bed.
  assert.match(sfx, /spec\.loop[\s\S]{0,80}PlaybackMode\.Ignore/);
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

test("sound and visual dispatch on ONE decision, not two if-chains", () => {
  // Phase 1 played the turret zap for every attack, aliens included, two lines
  // below a comment saying aliens "play a melee energy burst". Mirroring the
  // VFX's if-chain would have re-created that drift the first time a weapon was
  // added, so the decision itself is now shared: `shotProfileKey` picks the
  // bolt AND keys the clip.
  const combat = code("combat.ts");
  assert.match(combat, /playSfx\(SHOT_SFX\[shotProfileKey\(attacker\)\]\)/);
  assert.match(code("combatEffects.ts"), /export function shotProfileKey/);
  // combatEffects must USE it too, or the two can still diverge.
  assert.match(code("combatEffects.ts"), /return SHOT_PROFILES\[shotProfileKey\(attacker\)\]/);
  // No unconditional zap anywhere.
  assert.doesNotMatch(combat, /\n\s*playSfx\("turretZap"\);/);
});

test("every weapon profile has a sound", () => {
  // SHOT_SFX is typed on `ReturnType<typeof shotProfileKey>`, so a new weapon
  // fails to compile until it is given a clip rather than silently inheriting
  // a wrong one. Assert the map is complete against the profile table.
  const effects = code("combatEffects.ts");
  const profiles = [...(/const SHOT_PROFILES[\s\S]*?\n\};/.exec(effects)?.[0] ?? "")
    .matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
  assert.ok(profiles.length >= 6, "did not find the shot profiles");
  const map = /const SHOT_SFX[\s\S]*?\n\};/.exec(code("combat.ts"))?.[0] ?? "";
  for (const key of profiles) {
    assert.match(map, new RegExp(`\\b${key}:`), `${key} has no sound in SHOT_SFX`);
  }
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
  // Scoped to the disposal path, not to wave.ts as a whole — the file also
  // fires the wave siren, which is legitimate. The rule is that DISCARDING an
  // alien built for an abandoned wave makes no sound, because nothing killed it.
  const disposer =
    /private disposePreparedAliens\(\): void \{[\s\S]*?\n  \}/.exec(code("wave.ts"))?.[0] ?? "";
  assert.ok(disposer, "disposePreparedAliens not found");
  assert.doesNotMatch(disposer, /playSfx/);
});

test("generator clips reset every piece of their own state", () => {
  // Lazily creating state in render() (`this.phase ?? 0`) meant a clip rendered
  // twice in one process produced different samples, which quietly breaks the
  // guarantee that a partial re-render matches a full run.
  const gen = readFileSync(new URL("../scripts/generate-audio.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(gen, /this\.\w+ \?\? 0/, "per-clip state must be reset in setup(), not created lazily");
});

test("the economy cues sit past their own bail-outs", () => {
  // Each of these has a path that must stay SILENT, and in every case the
  // silent path is an early return above the hook.
  //
  // `place` fires after the site is fully built, not on entry — a placement
  // rejected by validation must make no sound.
  const construction = code("construction.ts");
  const create = /export function createConstructionSite\([\s\S]*?\n\}/.exec(construction)?.[0] ?? "";
  assert.ok(create, "createConstructionSite not found");
  const placeAt = create.indexOf('playSfx("place")');
  assert.ok(placeAt > 0, "place is not hooked");
  assert.ok(placeAt < create.indexOf("return world"), "place must fire before the return");
  assert.ok(placeAt > create.indexOf("attachQueueBadge"), "place must fire after the site is built");

  // `demolish` fires past the refusal check.
  const demolition = code("demolition.ts");
  assert.match(
    demolition,
    /if \(refusal\) return refusal;[\s\S]{0,40}playSfx\("demolish"\)/,
    "a refused demolish must stay silent",
  );
  // ...and must NOT reuse the friendly-death clip: losing something to aliens
  // and choosing to remove it are different events.
  assert.doesNotMatch(demolition, /playSfx\("friendlyDeath"\)/);
});

test("the miner's round trip is two different sounds", () => {
  // Hooked to the cargo CHANGE, not the stage: a miner parked in a stage must
  // not re-report, and the branch the trace already trusts decides which half
  // of the trip this is.
  const mining = code("mining.ts");
  assert.match(
    mining,
    /if \(this\.cycle\.cargo !== previousCargo\)[\s\S]*?playSfx\(\s*transition === "loadedCargo" \? "crystal" : "deposit",?\s*\)/,
  );
});

test("completion cues fire from the completion functions", () => {
  assert.match(code("construction.ts"), /private completeBuilding\(site: Entity\): void \{\s*playSfx\("buildDone"\)/);
  assert.match(code("craftProduction.ts"), /private completeCraft\(site: Entity\): void \{\s*playSfx\("craftReady"\)/);
});

test("economy cues are mixed under the weapons", () => {
  // The phase's actual job. A crystal chime fires on a loop all match; if it
  // sits at weapon volume it masks the cue that matters.
  const loudestEconomy = Math.max(
    SFX_CATALOG.crystal.volume,
    SFX_CATALOG.deposit.volume,
    SFX_CATALOG.place.volume,
  );
  const quietestWeapon = Math.min(
    SFX_CATALOG.turretZap.volume,
    SFX_CATALOG.plasma.volume,
    SFX_CATALOG.laser.volume,
  );
  assert.ok(
    loudestEconomy <= quietestWeapon,
    `economy cue at ${loudestEconomy} is not below the quietest weapon at ${quietestWeapon}`,
  );
  // The most frequent cue in the game must be the quietest ONE-SHOT. Ambience
  // is quieter still, but it is a bed rather than an event and is not competing
  // for the same attention.
  const oneShots = (Object.entries(SFX_CATALOG) as [SfxId, SfxSpec][])
    .filter(([, spec]) => !spec.loop)
    .map(([, spec]) => spec.volume);
  assert.equal(SFX_CATALOG.crystal.volume, Math.min(...oneShots));
  for (const id of AMBIENCE_IDS) {
    assert.ok(
      SFX_CATALOG[id].volume < SFX_CATALOG.crystal.volume,
      `${id} must sit under every one-shot`,
    );
  }
});

/** Mean square amplitude of a generated clip, from disk. */
const rmsOf = (url: string): number => {
  const buf = readFileSync(new URL(`../public${url}`, import.meta.url));
  const n = (buf.length - 44) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + i * 2) / 32767;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
};
/** How loud a clip actually is, which `volume` alone does not say. */
const effective = (id: SfxId): number =>
  SFX_CATALOG[id].volume * rmsOf(SFX_CATALOG[id].url);

test("the mix is asserted on measured loudness, not on volume numbers", () => {
  // Every clip is peak-normalized to 0.89, so `volume` says nothing about how
  // loud one sounds against another — the bank's rms spans 0.11 to 0.51. The
  // siren is a dense sawtooth at ~3x a weapon's rms, so its low-looking 0.34
  // lands ABOVE victory's 0.90. Comparing the raw numbers would have passed a
  // mix that is audibly wrong.
  const siren = effective("waveSiren");
  const victory = effective("victory");
  const defeat = effective("defeat");
  const loudestWeapon = Math.max(
    effective("turretZap"), effective("plasma"), effective("laser"), effective("melee"),
  );
  const loudestEconomy = Math.max(
    effective("crystal"), effective("deposit"), effective("place"),
    effective("buildDone"), effective("craftReady"), effective("demolish"),
  );

  // Wave and match cues mark the only moments that change what the player
  // should be doing, so they sit on top.
  for (const [name, v] of [["siren", siren], ["victory", victory], ["defeat", defeat]] as const) {
    assert.ok(v > loudestWeapon, `${name} (${v.toFixed(4)}) must be above the loudest weapon (${loudestWeapon.toFixed(4)})`);
    assert.ok(v > loudestEconomy, `${name} (${v.toFixed(4)}) must be above the loudest economy cue (${loudestEconomy.toFixed(4)})`);
  }
  // Losing a unit must register above the shot that killed it.
  assert.ok(effective("friendlyDeath") > loudestWeapon);
  // The most frequent cue in the game stays under the weapons.
  assert.ok(effective("crystal") < loudestWeapon);
});

test("wave and match cues are one-shot and transition-gated", () => {
  // A looping siren would still be wailing through the fight it announced.
  for (const id of ["waveSiren", "victory", "defeat"] as const) {
    assert.equal(SFX_CATALOG[id].voices, 1, `${id} must not overlap itself`);
    assert.ok(SFX_CATALOG[id].cooldownMs >= 1000, `${id} needs a long leash`);
  }
  // The siren fires on the edge `advanceWaveClock` returns, not on the stage.
  assert.match(code("wave.ts"), /if \(activated\) \{\s*playSfx\("waveSiren"\)/);
  // Victory/defeat fire past the transition guard, and the tutorial dead end
  // stays silent — nothing was destroyed and the player did nothing wrong.
  const result = code("matchResult.ts");
  assert.match(result, /status === this\.lastStatus\) return;[\s\S]*?if \(status === "victory"\) playSfx\("victory"\);/);
  assert.doesNotMatch(result, /tutorialDeadEnd.*playSfx|playSfx.*tutorialDeadEnd/);
});

test("the SFX volume knob exists end to end", () => {
  // A knob is four separate things and any one of them missing makes it inert.
  const state = readFileSync(new URL("../src/systems/state.ts", import.meta.url), "utf8");
  assert.match(state, /sfxVolume: \{ type: Types\.Float32, default: 1 \}/, "no component field");
  assert.match(state, /\| "sfxVolume"/, "not in the settings key union");

  const catalog = readFileSync(new URL("../src/systems/debugSettingsCatalog.ts", import.meta.url), "utf8");
  assert.match(catalog, /key: "sfxVolume"/, "no catalog row");

  const ui = readFileSync(new URL("../ui/rts-settings.uikitml", import.meta.url), "utf8");
  for (const part of ["minus", "value", "plus"]) {
    assert.ok(ui.includes(`setting-sfxVolume-${part}`), `no ${part} control in the settings panel`);
  }

  // ...and something must actually read it.
  assert.match(code("sfx.ts"), /DebugSettings,\s*"sfxVolume",/, "nothing consumes the setting");
});

test("the knob is polled on change, never read per play", () => {
  const sfx = code("sfx.ts");
  // `volume` is component data; reading it inside playSfx would put a component
  // read on a path that runs at combat rates.
  const play = /export function playSfx[\s\S]*?\n\}/.exec(sfx)?.[0] ?? "";
  assert.doesNotMatch(play, /DebugSettings|getValue/);
  // The poll writes only when the number actually moves.
  assert.match(sfx, /if \(scale === appliedScale\) return;/);
  // null AND undefined: the reader returns null before the singleton exists,
  // and Math.min would coerce that to 0 — silencing the bank at boot.
  assert.match(sfx, /setting === undefined \|\| setting === null/);
});

test("volume 0 is the off switch — no second control", () => {
  // A separate enabled flag would be a second way to say the same thing.
  assert.doesNotMatch(code("sfx.ts"), /setSfxEnabled|sfxEnabled/);
});

test("ambience is wired as a bed, not as an event", () => {
  for (const name of ["amb-base-hum.wav", "amb-wind.wav"]) {
    assert.ok(existsSync(new URL(`../public/audio/${name}`, import.meta.url)), `${name} missing`);
  }
  // Declared as loops, and reachable only through the ambience API.
  for (const id of AMBIENCE_IDS) {
    assert.equal(SFX_CATALOG[id].loop, true, `${id} must be a loop`);
    assert.equal(SFX_CATALOG[id].voices, 1, `${id} must not layer on itself`);
  }
  const sfx = code("sfx.ts");
  // A loop started through the one-shot path would never stop, and the cooldown
  // would make that intermittent rather than obvious.
  assert.match(sfx, /if \(spec\.loop\) return;/);
  assert.match(sfx, /export function startAmbience\(\): void/);
  assert.match(sfx, /export function stopAmbience\(\): void/);
});

test("the beds are DERIVED from match status, not hand-started", () => {
  // Regression. They were hooked to `startMatch` and the result transition, and
  // a Restart goes through neither: `scenarioReset` calls `clearSfx()` (which
  // stops the beds) then writes `status` directly, so nothing started them
  // again and the rest of the session ran silent. `startMatch` would not have
  // helped even if called — it returns early unless status is `awaiting-start`.
  const sfx = code("sfx.ts");
  const update = /update\(\): void \{[\s\S]*?\n  \}/.exec(sfx)?.[0] ?? "";
  assert.ok(update, "SfxSystem.update not found");
  assert.match(update, /status === "playing"\) startAmbience\(\);/);
  assert.match(update, /else stopAmbience\(\);/);

  // No hand-wired starts anywhere — that is what could be forgotten.
  for (const file of ["matchStart.ts", "matchResult.ts", "scenarioReset.ts"]) {
    assert.doesNotMatch(
      code(file),
      /startAmbience|stopAmbience/,
      `${file} must not drive the beds directly`,
    );
  }

  // Called every frame, so both must be cheap and idempotent.
  assert.match(sfx, /export function startAmbience\(\): void \{\s*if \(ambiencePlaying\) return;/);
  assert.match(sfx, /export function stopAmbience\(\): void \{\s*if \(!ambiencePlaying\) return;/);

  // A reset clears the latch; update() restarts on the next frame.
  const clear = /export function clearSfx\(\): void \{[\s\S]*?\n\}/.exec(sfx)?.[0] ?? "";
  assert.match(clear, /ambiencePlaying = false;/);
});

test("the ambience loops are seamless, by two different techniques", () => {
  // A one-shot can end however it likes; a loop that does not arrive back where
  // it started ticks once per period, forever.
  const seam = (name: string) => {
    const buf = readFileSync(new URL(`../public/audio/${name}`, import.meta.url));
    const n = (buf.length - 44) / 2;
    const at = (i: number) => buf.readInt16LE(44 + i * 2) / 32767;
    const w = Math.floor(22050 * 0.05);
    let head = 0, tail = 0;
    for (let i = 0; i < w; i++) head += at(i) ** 2;
    for (let i = n - w; i < n; i++) tail += at(i) ** 2;
    return Math.sqrt(head / w) / (Math.sqrt(tail / w) || 1e-9);
  };
  // Energy either side of the wrap must match, or the loop pumps once a period.
  // (A one-shot fails this badly — sfx-turret-zap measures ~38x.)
  for (const name of ["amb-base-hum.wav", "amb-wind.wav"]) {
    const ratio = seam(name);
    assert.ok(ratio > 0.8 && ratio < 1.25, `${name} energy across the wrap is ${ratio.toFixed(2)}x`);
  }
  // The two use different methods, and the generator must keep both.
  const gen = readFileSync(new URL("../scripts/generate-audio.mjs", import.meta.url), "utf8");
  assert.match(gen, /Math\.round\(55 \* 4\.0\) \/ 4\.0/, "tone loop must be made periodic");
  assert.match(gen, /function crossfade\(samples, fadeCount\)/, "noise loop must be crossfaded");
  assert.match(gen, /Math\.sin\(x\) \+ samples\[n \+ i\] \* Math\.cos\(x\)/, "crossfade must be equal-power");
});

test("ambience retries instead of latching into a suspended context", () => {
  // Measured: `console-logs/2026-08-29-Audio-Plan_phase5_full.log`. The match
  // started at t+12.2s, the AudioContext was still suspended, `play()` was
  // accepted and produced nothing, `ambiencePlaying` latched, and the beds were
  // silent for the whole 853-second session.
  //
  // The trigger is the NORMAL headset path: that session entered XR through the
  // browser's own Enter XR pill, which does not credit a user gesture the way
  // the landing button does.
  const sfx = code("sfx.ts");
  const start = /export function startAmbience\(\): void \{[\s\S]*?\n\}/.exec(sfx)?.[0] ?? "";
  assert.ok(start, "startAmbience not found");

  // The state check must come BEFORE the latch, or the latch still wins.
  const checkAt = start.indexOf("audioContextState()");
  const latchAt = start.indexOf("ambiencePlaying = true;");
  assert.ok(checkAt >= 0, "startAmbience does not check the context state");
  assert.ok(latchAt > checkAt, "the latch must not be set before the state check");
  assert.match(start, /state === "suspended" \|\| state === "none"/);

  // An unexpected state must PROCEED, not block — silencing ambience forever is
  // the failure being fixed, so the guard names what it rejects, never what it
  // allows.
  assert.doesNotMatch(start, /state !== "running"/);
});

test("nothing that latches may latch into a suspended context", () => {
  // The rule, not the instance. Anything that starts once and runs until told
  // to stop must check the context BEFORE recording that it started — a
  // suspended `AudioContext` accepts `play()` and produces nothing.
  //
  // Two places latch: the ambient beds (`sfx.ts`) and the under-attack alarm
  // (`underAttackAudio.ts`). The beds stayed silent for an entire 853-second
  // session; the alarm self-heals but still loses one whole alert. One-shots
  // never latch, so they retry by themselves and are exempt.
  const cases: Array<[string, RegExp, string]> = [
    ["sfx.ts", /export function startAmbience\(\): void \{[\s\S]*?\n\}/, "ambiencePlaying = true;"],
    ["underAttackAudio.ts", /export function holdCommandCenterAlarm\(\): void \{[\s\S]*?\n\}/, "alarmPlaying = true;"],
  ];
  for (const [file, fnPattern, latch] of cases) {
    const body = fnPattern.exec(code(file))?.[0] ?? "";
    assert.ok(body, `${file}: function not found`);
    const checkAt = body.indexOf("audioContextState()");
    const latchAt = body.indexOf(latch);
    assert.ok(checkAt >= 0, `${file} does not check the context state`);
    assert.ok(latchAt > checkAt, `${file} latches before checking the context`);
    // Rejects the known-bad states; anything unexpected proceeds.
    assert.match(body, /=== "suspended" \|\| \w+ === "none"/, `${file}: wrong guard shape`);
    assert.doesNotMatch(body, /!== "running"/, `${file}: an unknown state must not block`);
  }
});
