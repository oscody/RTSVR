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
    matchStatus: "playing",
    commandCenterAlive: true,
  });
}

export function isScenarioRestartRequested(status: string): boolean {
  return status === "restarting";
}
