import { type World } from "@iwsdk/core";
import { WaveSystem } from "./wave.js";

// Lightweight per-system frame profiler. Wraps the update() of EVERY registered
// system and records how long each takes, so on-device pauses can be attributed
// to a system instead of guessed at. Nothing is logged to the console —
// PerformanceSystem (performance.ts) calls flushFrameProfile() on its FPS sample
// tick to refresh the HUD text, which the tablet's Settings tab shows via
// getFrameProfileHud(). Flip FRAME_PROFILER_ENABLED off to disable.
const FRAME_PROFILER_ENABLED = true;
// Every system, 6 per line, in the tablet's dedicated (taller) frame-profile row.
const HUD_PER_LINE = 6;

interface ProfSlot {
  label: string;
  short: string;
  frames: number;
  totalMs: number;
  maxMs: number;
}

const slots: ProfSlot[] = [];
let installed = false;
// Compact summary for the tablet HUD (worst-frame ms per system),
// refreshed each time PerformanceSystem flushes. Read via getFrameProfileHud().
let hudLine = "";

function slotFor(label: string, short: string): ProfSlot {
  for (const slot of slots) if (slot.label === label) return slot;
  const slot: ProfSlot = { label, short, frames: 0, totalMs: 0, maxMs: 0 };
  slots.push(slot);
  return slot;
}

function record(slot: ProfSlot, ms: number): void {
  slot.frames += 1;
  slot.totalMs += ms;
  if (ms > slot.maxMs) slot.maxMs = ms;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapUpdate(system: any, label: string, short: string): void {
  if (!system || typeof system.update !== "function") return;
  const slot = slotFor(label, short);
  const original = system.update.bind(system);
  system.update = (delta: number, time: number) => {
    const start = performance.now();
    original(delta, time);
    record(slot, performance.now() - start);
  };
}

// Wrap a named method (even a private one) so a spike inside a system can be
// isolated — e.g. wave spawning, which only costs on its activation frame.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapMethod(system: any, method: string, label: string, short: string): void {
  if (!system || typeof system[method] !== "function") return;
  const slot = slotFor(label, short);
  const original = system[method].bind(system);
  system[method] = (...args: unknown[]) => {
    const start = performance.now();
    const result = original(...args);
    record(slot, performance.now() - start);
    return result;
  };
}

/**
 * Rebuild the compact worst-frame-ms-per-system HUD line and reset the
 * accumulators. Called by PerformanceSystem on its sample tick so the tablet
 * text and the FPS sample share one cadence. Nothing is logged to the console.
 */
export function flushFrameProfile(): void {
  if (!installed || slots.length === 0) return;
  // Runs at 1 Hz (PerformanceSystem sample tick), so allocation here is fine.
  // Every system's worst-frame ms, chunked HUD_PER_LINE per line.
  const parts: string[] = [];
  for (const slot of slots) {
    parts.push(`${slot.short} ${slot.maxMs.toFixed(1)}`);
    slot.frames = 0;
    slot.totalMs = 0;
    slot.maxMs = 0;
  }
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += HUD_PER_LINE) {
    lines.push(parts.slice(i, i + HUD_PER_LINE).join(" | "));
  }
  hudLine = lines.join("\n");
}

/** Compact profiler summary for the tablet HUD (empty until first flush). */
export function getFrameProfileHud(): string {
  return hudLine;
}

// Short HUD label from a class name: drop the "System" suffix and abbreviate
// "Animation" so the line stays narrow (e.g. AlienAnimationSystem -> AlienAnim).
function shortName(className: string): string {
  return className.replace(/System$/, "").replace(/Animation/g, "Anim");
}

/**
 * Wrap EVERY registered system's update() (plus WaveSystem's private spawn, so
 * the wave-spawn spike shows separately) to record per-frame cost. Call once
 * after all game systems are registered. No-op when disabled or if called twice.
 */
export function installFrameProfiler(world: World): void {
  if (!FRAME_PROFILER_ENABLED || installed) return;
  installed = true;
  for (const system of world.getSystems()) {
    const name = system.constructor.name;
    wrapUpdate(system, name, shortName(name));
  }
  wrapMethod(world.getSystem(WaveSystem), "spawnWaveIfNeeded", "WaveSystem.spawn", "Spawn");
}
