// Procedurally synthesizes RTSVR's sound bank into public/audio/.
//
//   node scripts/generate-audio.mjs            # every clip
//   node scripts/generate-audio.mjs zap click  # only clips whose name contains these
//
// Ported from `vr_examples/space-station/scripts/generate-audio.mjs`, which
// supplies the reusable core: the 44-byte RIFF writer, peak normalization to
// 0.89 headroom, and a seeded LCG so re-running produces byte-identical files
// and never a spurious diff.
//
// ## Why synthesis rather than sourced audio
//
// No licensing surface, tunable in the same edit loop as the game, tiny, and
// deterministic. The honest limit: this makes retro/sci-fi synthesized sound,
// not recorded foley. It suits a Martian diorama with Kenney-style low-poly
// art; it will not produce voice lines or realistic explosions.
//
// ## WAV, and specifically PCM
//
// `constants.ts:382` records the measurement: an Ogg loop and an MP3 sting both
// decoded in desktop Chrome and were **silent on Quest**. PCM removes the
// question. It also has no encoder padding, which is what puts an audible tick
// at a loop seam no matter how clean the synthesis is — see `LOOPABLE` below.
//
// Design: `RTSVR_repos/devlog/plan/2026-08-09-Game-Audio-Plan.md`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");
const SAMPLE_RATE = 22050;
const TAU = Math.PI * 2;

const seconds = (s) => Math.floor(s * SAMPLE_RATE);

/**
 * Deterministic noise. Seeded once per clip by `renderClip` so a clip's output
 * never depends on which other clips ran before it — that is what keeps
 * `node scripts/generate-audio.mjs zap` byte-identical to a full run.
 */
let noiseState = 1337;
const reseed = (seed) => void (noiseState = seed);
function rand() {
  noiseState = (noiseState * 1103515245 + 12345) & 0x7fffffff;
  return noiseState / 0x3fffffff - 1;
}

/** One-pole lowpass. `k` is per-sample coefficient: smaller = darker. */
function makeLowpass(k) {
  let z = 0;
  return (x) => (z += k * (x - z));
}

/** Exponential decay envelope, the workhorse. */
const decay = (t, rate) => Math.exp(-rate * t);

function writeWav(name, samples) {
  // Refuse to write a broken clip.
  //
  // `sfx-plasma` shipped as 10 KB of zeros because `setup()` forgot one field,
  // so `this.z += …` produced NaN for every sample. Normalization then read a
  // NaN peak, `peak > 0` was false, gain fell back to 1, and `writeInt16LE(NaN)`
  // wrote silence — a valid WAV of nothing, with no error anywhere. It was only
  // caught by measuring the output afterwards.
  //
  // A generator that can emit silence without complaint is worse than one that
  // crashes: the failure survives all the way to a device test.
  let peak = 0;
  let nans = 0;
  for (const s of samples) {
    if (!Number.isFinite(s)) nans += 1;
    else peak = Math.max(peak, Math.abs(s));
  }
  if (nans > 0) {
    throw new Error(
      `${name}: ${nans} non-finite sample(s). A field used in render() is not initialized in setup().`,
    );
  }
  if (peak <= 0) {
    throw new Error(`${name}: rendered to silence (peak 0). The recipe produces no signal.`);
  }
  const gain = 0.89 / peak;

  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] * gain));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), buf);
  const kb = (44 + dataSize) / 1024;
  console.log(
    `  ${name.padEnd(24)} ${(samples.length / SAMPLE_RATE).toFixed(2)}s  ${kb.toFixed(0)} KB`,
  );
}

// ── Clips ─────────────────────────────────────────────────────────────────
//
// Each entry: { name, dur, seed, render(t, i) -> sample }.
// Parameters come from the plan's recipe table; every one of them is a first
// guess that expects to be tuned by ear. `scripts/audio-preview.html` exists so
// that loop is seconds rather than a rebuild and a match.

const CLIPS = [
  {
    // Must be near-inaudible in isolation — it is the texture under every tap,
    // not an event in its own right.
    name: "sfx-click.wav",
    dur: 0.06,
    seed: 5501,
    render(t) {
      const attack = Math.min(1, t / 0.002);
      return Math.sin(TAU * 1800 * t) * attack * decay(t, 90);
    },
  },
  {
    // Bright and dry, because it has to survive being fired ~4x/second without
    // smearing into a single tone.
    name: "sfx-turret-zap.wav",
    dur: 0.18,
    seed: 5502,
    setup() {
      // Every piece of per-clip state is reset HERE, never created lazily in
      // render(). Rendering a clip twice in one process must produce identical
      // samples, or `node scripts/generate-audio.mjs zap` stops being
      // comparable to a full run — which is the whole point of the seeding.
      this.lp = makeLowpass(0.5);
      this.phase = 0;
    },
    render(t) {
      // 900 -> 380 Hz over the first 60 ms, then held.
      const sweep = t < 0.06 ? 900 + (380 - 900) * (t / 0.06) : 380;
      // Integrated phase, or the sweep audibly steps.
      this.phase += (TAU * sweep) / SAMPLE_RATE;
      const body = Math.sin(this.phase) * decay(t, 28);
      const transient = t < 0.001 ? this.lp(rand()) * 0.8 : 0;
      return body + transient;
    },
  },
  {
    // Noise falling through a closing filter plus a descending body tone: the
    // shape reads as "something organic stopped".
    name: "sfx-alien-death.wav",
    dur: 0.6,
    seed: 5503,
    setup() {
      // No `makeLowpass` here: this clip needs a *moving* cutoff, so it
      // re-derives the one-pole coefficient per sample below rather than
      // holding a fixed-k filter. The earlier fixed one was never read.
      this.z = 0;
      this.phase = 0;
    },
    render(t) {
      // Recreate a falling cutoff by re-deriving the one-pole coefficient.
      const cutoff = 1200 + (120 - 1200) * Math.min(1, t / 0.5);
      const k = Math.min(1, (TAU * cutoff) / SAMPLE_RATE);
      this.z += k * (rand() - this.z);
      const body = 300 + (80 - 300) * Math.min(1, t / 0.5);
      this.phase += (TAU * body) / SAMPLE_RATE;
      return (this.z * 1.6 + Math.sin(this.phase) * 0.5) * decay(t, 7);
    },
  },
  {
    // The fighter's paired cannons: two detuned saws through a falling lowpass.
    // Deliberately fatter and duller than the turret so a mixed volley reads as
    // two weapons rather than one stuttering.
    name: "sfx-plasma.wav",
    dur: 0.22,
    seed: 5504,
    setup() {
      this.z = 0;
    },
    render(t) {
      // Saw from phase, cheaper and sharper than summing harmonics.
      const saw = (f) => 2 * ((t * f) % 1) - 1;
      const raw = saw(240) * 0.5 + saw(243) * 0.5;
      // Falling cutoff: bright attack, dull tail.
      const k = 0.35 * Math.max(0.08, 1 - t / 0.18);
      this.z += k * (raw - this.z);
      return this.z * decay(t, 18);
    },
  },
  {
    // Astronaut rifle: a fast chirp with an octave above it. Short and thin, so
    // it cuts through a volley without adding weight.
    name: "sfx-laser.wav",
    dur: 0.15,
    seed: 5505,
    setup() {
      this.phase = 0;
      this.octave = 0;
    },
    render(t) {
      const f = 1400 + (600 - 1400) * Math.min(1, t / 0.09);
      this.phase += (TAU * f) / SAMPLE_RATE;
      this.octave += (TAU * f * 2) / SAMPLE_RATE;
      return (Math.sin(this.phase) + Math.sin(this.octave) * 0.2) * decay(t, 34);
    },
  },
  {
    // Alien strike: the `clank` modal stack transposed down, plus a heavy noise
    // burst. No tonal sustain — it must read as impact, not as a weapon.
    name: "sfx-melee.wav",
    dur: 0.25,
    seed: 5506,
    setup() {
      this.modes = [
        [60, 14, 0.5],
        [97, 20, 0.32],
        [210, 30, 0.18],
      ];
    },
    render(t) {
      let s = 0;
      for (const [f, d, a] of this.modes) s += Math.sin(TAU * f * t) * decay(t, d) * a;
      return s + rand() * decay(t, 45) * 0.6;
    },
  },
  {
    // Losing something of ours. Same falling shape as the alien death, an
    // octave lower and longer, plus a metallic debris tail at 180 ms so it
    // reads as structure failing rather than a creature dying.
    name: "sfx-friendly-death.wav",
    dur: 0.8,
    seed: 5507,
    setup() {
      this.z = 0;
      this.phase = 0;
      this.debris = [
        [640, 26, 0.22],
        [910, 32, 0.15],
        [1330, 38, 0.1],
      ];
    },
    render(t) {
      const cutoff = 900 + (90 - 900) * Math.min(1, t / 0.6);
      const k = Math.min(1, (TAU * cutoff) / SAMPLE_RATE);
      this.z += k * (rand() - this.z);
      const body = 150 + (50 - 150) * Math.min(1, t / 0.6);
      this.phase += (TAU * body) / SAMPLE_RATE;
      let s = (this.z * 1.5 + Math.sin(this.phase) * 0.6) * decay(t, 5);
      if (t > 0.18) {
        const d = t - 0.18;
        for (const [f, rate, a] of this.debris) {
          s += Math.sin(TAU * f * d) * decay(d, rate) * a;
        }
      }
      return s;
    },
  },
  {
    // A miner has filled up. Two-tone chime, D6 -> G6, with a slightly detuned
    // second partial so it rings rather than beeps. Quiet: it fires on a loop
    // all match and must never compete with combat.
    name: "sfx-crystal.wav",
    dur: 0.35,
    seed: 5508,
    setup() {
      this.a = 0;
      this.b = 0;
      this.det = 0;
    },
    render(t) {
      this.a += (TAU * 1174) / SAMPLE_RATE;
      this.b += (TAU * 1568) / SAMPLE_RATE;
      this.det += (TAU * 1572) / SAMPLE_RATE;
      // Second note enters at 90 ms, so it reads as two events not a chord.
      const first = Math.sin(this.a) * decay(t, 9);
      const second =
        t > 0.09
          ? (Math.sin(this.b) + Math.sin(this.det) * 0.3) * decay(t - 0.09, 9)
          : 0;
      return first * 0.7 + second * 0.6;
    },
  },
  {
    // Crystals arriving at the base: a rising triangle with a soft noise pour
    // under it. Rising, where the pickup falls — the pair reads as a round trip.
    name: "sfx-deposit.wav",
    dur: 0.3,
    seed: 5509,
    setup() {
      this.phase = 0;
      this.z = 0;
    },
    render(t) {
      const f = 660 + (880 - 660) * Math.min(1, t / 0.22);
      this.phase += (TAU * f) / SAMPLE_RATE;
      // Triangle from the phase: softer than a saw, less pure than a sine.
      const tri = (2 / Math.PI) * Math.asin(Math.sin(this.phase));
      this.z += 0.08 * (rand() - this.z);
      return tri * decay(t, 11) * 0.8 + this.z * decay(t, 7) * 0.5;
    },
  },
  {
    // A stake going into ground. The melee modal stack an octave down at half
    // amplitude, no noise tail — placement is a decision, not an impact.
    name: "sfx-place.wav",
    dur: 0.3,
    seed: 5510,
    setup() {
      this.modes = [
        [82, 16, 0.5],
        [151, 24, 0.3],
      ];
    },
    render(t) {
      let s = 0;
      for (const [f, d, a] of this.modes) s += Math.sin(TAU * f * t) * decay(t, d) * a;
      return s * 0.55 + rand() * decay(t, 60) * 0.2;
    },
  },
  {
    // Three-note rising arpeggio, C5-E5-G5, then a closing thunk. The only
    // clearly "musical" cue in the bank, because finishing a building is the
    // rarest good thing that happens.
    name: "sfx-build-done.wav",
    dur: 0.9,
    seed: 5511,
    setup() {
      this.notes = [523, 659, 784];
    },
    render(t) {
      let s = 0;
      for (let i = 0; i < this.notes.length; i++) {
        const start = i * 0.18;
        if (t < start) continue;
        s += Math.sin(TAU * this.notes[i] * (t - start)) * decay(t - start, 6) * 0.5;
      }
      // Closing thunk at 0.54s, so the arpeggio lands rather than fading out.
      if (t > 0.54) {
        const d = t - 0.54;
        s += Math.sin(TAU * 110 * d) * decay(d, 12) * 0.45;
      }
      return s;
    },
  },
  {
    // A craft rolling out: servo pitch ramp, then a two-tone confirm. Shares the
    // build-done language without repeating it, so the two are distinguishable
    // when they land seconds apart.
    name: "sfx-craft-ready.wav",
    dur: 0.7,
    seed: 5512,
    setup() {
      this.phase = 0;
      this.z = 0;
      this.a = 0;
      this.b = 0;
    },
    render(t) {
      const f = 70 + (120 - 70) * Math.min(1, t / 0.4);
      this.phase += (TAU * f) / SAMPLE_RATE;
      this.z += 0.12 * (rand() - this.z);
      const motor = (Math.sin(this.phase) * 0.6 + this.z * 0.4) * Math.min(1, t / 0.05);
      const ramp = t < 0.45 ? motor * (1 - t / 0.6) : 0;
      let confirm = 0;
      if (t > 0.45) {
        const d = t - 0.45;
        this.a += (TAU * 784) / SAMPLE_RATE;
        this.b += (TAU * 1047) / SAMPLE_RATE;
        confirm = (Math.sin(this.a) * (d < 0.1 ? 1 : 0) + Math.sin(this.b) * (d >= 0.1 ? 1 : 0)) * decay(d, 10) * 0.55;
      }
      return ramp + confirm;
    },
  },
  {
    // Rubble. Longer decay than melee and deliberately without a tonal body —
    // demolishing is destructive but voluntary, so it should sound heavy and
    // final rather than violent.
    name: "sfx-demolish.wav",
    dur: 0.7,
    seed: 5513,
    setup() {
      this.z = 0;
      this.modes = [
        [70, 7, 0.3],
        [128, 10, 0.2],
        [193, 13, 0.14],
      ];
    },
    render(t) {
      const cutoff = 1600 + (150 - 1600) * Math.min(1, t / 0.5);
      const k = Math.min(1, (TAU * cutoff) / SAMPLE_RATE);
      this.z += k * (rand() - this.z);
      let s = this.z * decay(t, 4) * 1.4;
      for (const [f, d, a] of this.modes) s += Math.sin(TAU * f * t) * decay(t, d) * a;
      return s;
    },
  },
  {
    // Wave incoming. The donor klaxon pitched down into a warning rather than an
    // alarm, and one-shot rather than looped — the wave arriving IS the event,
    // so a sustained siren would still be wailing during the fight.
    //
    // Two sweeps: one reads as a blip, three as a drill.
    name: "sfx-wave-siren.wav",
    dur: 2.0,
    seed: 5514,
    setup() {
      this.phase = 0;
    },
    render(t) {
      // Each sweep runs 300 -> 560 Hz over 0.8s, with a gap between them.
      const local = t % 1.0;
      const sweeping = local < 0.8;
      const f = 300 + (560 - 300) * (sweeping ? local / 0.8 : 1);
      this.phase += (TAU * f) / SAMPLE_RATE;
      // Sawtooth body: a siren is not a sine, and the harmonics are what let it
      // carry over a fight.
      const saw = (2 * ((this.phase / TAU) % 1) - 1) * 0.4;
      const body = Math.sin(this.phase) * 0.6 + saw;
      // Envelope per sweep, so the gap is real silence rather than a duck.
      const env = sweeping
        ? Math.min(1, local / 0.05) * Math.min(1, (0.8 - local) / 0.12)
        : 0;
      return body * env;
    },
  },
  {
    // Four-note major arpeggio with overlapping tails, so it lands as a chord
    // rather than four beeps. The only fully consonant sound in the bank —
    // nothing else resolves.
    name: "sfx-victory.wav",
    dur: 1.6,
    seed: 5515,
    setup() {
      this.notes = [523, 659, 784, 1047];
    },
    render(t) {
      let s = 0;
      for (let i = 0; i < this.notes.length; i++) {
        const start = i * 0.16;
        if (t < start) continue;
        const d = t - start;
        // Long tails (rate 3) so all four ring together at the end.
        s += Math.sin(TAU * this.notes[i] * d) * decay(d, 3) * 0.4;
        // A quiet fifth above each note, for body without a second melody.
        s += Math.sin(TAU * this.notes[i] * 1.5 * d) * decay(d, 4) * 0.12;
      }
      return s;
    },
  },
  {
    // Descending detuned pair under a slow noise swell. Slow decay (rate 2), so
    // it outlasts the moment rather than punctuating it — the opposite gesture
    // to victory, which resolves upward and stops.
    name: "sfx-defeat.wav",
    dur: 1.8,
    seed: 5516,
    setup() {
      this.a = 0;
      this.b = 0;
      this.z = 0;
    },
    render(t) {
      const f = 220 + (110 - 220) * Math.min(1, t / 1.4);
      this.a += (TAU * f) / SAMPLE_RATE;
      // 3 Hz detune: slow beating, which is what makes it sound wrong.
      this.b += (TAU * (f + 3)) / SAMPLE_RATE;
      const tone = (Math.sin(this.a) + Math.sin(this.b)) * 0.35 * decay(t, 2);
      // Noise swells in and fades, peaking around 0.5s.
      this.z += 0.05 * (rand() - this.z);
      const swell = Math.sin(Math.PI * Math.min(1, t / 1.2));
      return tone + this.z * swell * 0.5;
    },
  },
  // ── Ambience ────────────────────────────────────────────────────────────
  //
  // GENERATED BUT NOT WIRED, deliberately. These files exist so the loop
  // technique can be verified and the clips auditioned; nothing in `src/`
  // references them and they are absent from `sfxCatalog.ts` and the manifest.
  // Hooking them up is a separate decision — the plan's open question 2 is
  // whether a hum under a 20-minute session becomes fatiguing, and that needs a
  // playtest rather than a build.
  //
  // Both are SEAMLESS, which is the whole difficulty. A one-shot can end however
  // it likes; a loop that does not arrive back where it started ticks once per
  // period, forever. Two different techniques below, because noise and tone need
  // different answers.
  {
    // Tone: force every partial to a whole number of cycles across the file.
    // `Math.round(55 * dur) / dur` snaps 55 Hz to the nearest frequency that
    // completes exactly, and every harmonic is an integer multiple of that, so
    // the waveform is periodic with the file length by construction.
    name: "amb-base-hum.wav",
    dur: 4.0,
    seed: 5517,
    setup() {
      this.dur = 4.0;
      this.base = Math.round(55 * 4.0) / 4.0;
    },
    render(t) {
      const b = this.base;
      let s =
        Math.sin(TAU * b * t) * 0.55 +
        Math.sin(TAU * b * 2 * t) * 0.28 +
        Math.sin(TAU * b * 3 * t + 0.5) * 0.12 +
        Math.sin(TAU * (b * 0.5) * t) * 0.3;
      // Wobble at exactly 2 cycles per loop, so it also lands where it began.
      s *= 0.8 + 0.2 * Math.sin(TAU * (2 / this.dur) * t);
      return s;
    },
  },
  {
    // Noise cannot be made periodic, so the seam is CROSSFADED instead: render
    // slightly more than the loop length, then blend the overhang back over the
    // opening. `renderClip` does the splice — see `crossfade` there.
    //
    // The slow swell is still forced to whole cycles (1/6 Hz over 6s), because
    // a crossfade hides a discontinuity in the noise but not a mismatch in the
    // envelope riding on top of it.
    name: "amb-wind.wav",
    dur: 6.0,
    seed: 5518,
    crossfadeSeconds: 0.5,
    setup() {
      this.lp1 = 0;
      this.lp2 = 0;
    },
    render(t) {
      const w = rand();
      this.lp1 += 0.22 * (w - this.lp1);
      this.lp2 += 0.06 * (this.lp1 - this.lp2);
      const band = this.lp1 - this.lp2;
      const swell = 0.72 + 0.28 * Math.sin(TAU * (1 / 6.0) * t);
      return band * 2.2 * swell;
    },
  },
];

/**
 * Blend the overhang back over the opening so a noise loop has no seam.
 *
 * Renders `dur + fade` seconds, then mixes the trailing `fade` over the leading
 * `fade` with an equal-power curve. Equal-power (`cos`/`sin`) rather than linear:
 * two uncorrelated noise signals summed at 0.5 each are ~3 dB quieter than
 * either, so a linear crossfade dips audibly in the middle of the blend.
 *
 * Only for noise. A tone should be made periodic instead — see `amb-base-hum`.
 */
function crossfade(samples, fadeCount) {
  const n = samples.length - fadeCount;
  const out = new Float64Array(n);
  out.set(samples.subarray(0, n));
  for (let i = 0; i < fadeCount; i++) {
    const x = (i / fadeCount) * (Math.PI / 2);
    out[i] = out[i] * Math.sin(x) + samples[n + i] * Math.cos(x);
  }
  return out;
}

function renderClip(clip) {
  reseed(clip.seed);
  clip.setup?.();
  const fade = clip.crossfadeSeconds ?? 0;
  const n = seconds(clip.dur + fade);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = clip.render(i / SAMPLE_RATE, i);
  writeWav(clip.name, fade > 0 ? crossfade(out, seconds(fade)) : out);
}

const filters = process.argv.slice(2);
const selected = filters.length
  ? CLIPS.filter((c) => filters.some((f) => c.name.includes(f)))
  : CLIPS;

if (selected.length === 0) {
  console.error(`No clip matches ${filters.join(", ")}. Known clips:`);
  for (const c of CLIPS) console.error(`  ${c.name}`);
  process.exit(1);
}

console.log(`Writing ${selected.length} clip(s) to public/audio/`);
for (const clip of selected) renderClip(clip);
console.log("Done. Preview: open scripts/audio-preview.html");
