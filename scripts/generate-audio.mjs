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
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.89 / peak : 1;

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
];

function renderClip(clip) {
  reseed(clip.seed);
  clip.setup?.();
  const n = seconds(clip.dur);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = clip.render(i / SAMPLE_RATE, i);
  writeWav(clip.name, out);
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
