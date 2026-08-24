import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("Phase 2 traces the requested writer-to-reader boundaries", () => {
  const tutorial = source("src/systems/tutorial.ts");
  const wave = source("src/systems/wave.ts");
  const mining = source("src/systems/mining.ts");
  const tablet = source("src/systems/tablet.ts");
  const interaction = source("src/systems/interaction.ts");
  const construction = source("src/systems/construction.ts");
  const craft = source("src/systems/craftProduction.ts");
  const combat = source("src/systems/combat.ts");
  const reset = source("src/systems/scenarioReset.ts");

  assert.match(tutorial, /traceStateChange\(State\.TutorialDrill/);
  assert.match(wave, /Contract\.TutorialGateBeforeWavePrep/);
  assert.match(wave, /Lifecycle\.Waiting/);
  assert.match(wave, /Lifecycle\.Active/);
  assert.match(combat, /Contract\.DamageReachesAlertConsumers/);
  assert.match(mining, /trackMiningDeposit\(revision, corr\)/);
  assert.match(tablet, /observeMiningEconomyRead\(economyRevision\)/);
  assert.match(interaction, /trackPlacedSite\(/);
  assert.match(construction, /observePlacedSite\(site\.index, Consumer\.Construction\)/);
  assert.match(craft, /observePlacedSite\(site\.index, Consumer\.Production\)/);
  assert.match(reset, /clearPhase2Trace\(\)/);
});
