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
    spawnedWaveNumber: 0,
    releaseTimer: 0,
    releasedAlienCount: 0,
    matchStatus: "playing",
    commandCenterAlive: true,
  });
}

export function isScenarioRestartRequested(status: string): boolean {
  return status === "restarting";
}
