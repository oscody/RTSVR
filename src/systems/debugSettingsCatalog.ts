import type { DebugSettingKey } from "./state.js";

// Spec table for the tablet's Settings tab — the small set of tuning knobs
// that get changed constantly during playtesting. Each entry drives both the
// UIKitML row wiring (button ids follow `setting-${key}-minus/plus/value`)
// and the clamping/step/display-decimals rules in TabletSystem.
export interface DebugSettingSpec {
  key: DebugSettingKey;
  label: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
}

export const DEBUG_SETTINGS_CATALOG: readonly DebugSettingSpec[] = [
  {
    key: "alienMoveSpeed",
    label: "Alien Move Speed",
    step: 0.05,
    min: 0.05,
    max: 3,
    decimals: 2,
  },
  {
    key: "unitMoveSpeed",
    label: "Unit Move Speed",
    step: 0.05,
    min: 0.05,
    max: 3,
    decimals: 2,
  },
  {
    key: "initialWaveDelaySeconds",
    label: "Wave Start Delay (s)",
    step: 1,
    min: 0,
    max: 60,
    decimals: 0,
  },
  {
    key: "waveMaxActiveAliens",
    label: "Max Active Aliens",
    step: 1,
    min: 1,
    max: 20,
    decimals: 0,
  },
  {
    key: "waveReleaseIntervalSeconds",
    label: "Release Interval (s)",
    step: 0.5,
    min: 0.5,
    max: 30,
    decimals: 1,
  },
  {
    key: "turretRange",
    label: "Turret Range",
    step: 0.1,
    min: 0.1,
    max: 5,
    decimals: 2,
  },
  {
    key: "astronautAttackRange",
    label: "AstronautA Attack Range",
    step: 0.05,
    min: 0.1,
    max: 5,
    decimals: 2,
  },
  {
    key: "craftRacerAttackRange",
    label: "CraftRacer Attack Range",
    step: 0.05,
    min: 0.1,
    max: 5,
    decimals: 2,
  },
  {
    key: "miningGatherTimeSeconds",
    label: "Mining Gather Time (s)",
    step: 0.1,
    min: 0.1,
    max: 10,
    decimals: 1,
  },
];
