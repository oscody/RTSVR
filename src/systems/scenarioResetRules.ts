export function createScenarioResetDefaults(
  startingCrystals: number,
  waveTimer: number,
) {
  return Object.freeze({
    crystals: startingCrystals,
    crystalsMined: 0,
    enemiesKilled: 0,
    waveNumber: 1,
    waveTimer,
    waveStage: "countdown",
    // -1, not 0: wave 0 is the tutorial's level, so 0 here would read as
    // "wave 0 already spawned" and the restarted tutorial would spawn nothing.
    spawnedWaveNumber: -1,
    releaseTimer: 0,
    releasedAlienCount: 0,
    matchStatus: "playing",
    commandCenterAlive: true,
  });
}

export function isScenarioRestartRequested(status: string): boolean {
  return status === "restarting";
}
