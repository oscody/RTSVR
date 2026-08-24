import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("Phase 3 correlates supported world presses through their terminal result", () => {
  const interaction = source("src/systems/interaction.ts");

  assert.match(interaction, /beginWorldInteraction/);
  assert.match(interaction, /private observeWorldPress/);
  assert.match(interaction, /InteractionStage\.GameplayValidation/);
  assert.match(interaction, /InteractionStage\.StateChange/);
  assert.match(interaction, /InteractionStage\.VisualResponse/);
  assert.match(interaction, /finishInteraction\(\s*corr,\s*rejected \? Terminal\.RejectedWithReason : Terminal\.Success/);
  assert.match(interaction, /Terminal\.ActionFailure, Reason\.SystemError/);
  assert.match(interaction, /pressedBoard\.subscribe\("qualify", \(entity\)/);
  assert.match(interaction, /this\.placeCraft\(tx, ty, corr\)/);
  assert.match(interaction, /this\.placeConstructionSite\(tx, ty, corr\)/);
});

test("Phase 3 wraps every tablet UIKit click without polling rays", () => {
  const tablet = source("src/systems/tablet.ts");
  const correlation = source("src/systems/traceInteraction.ts");
  const trace = source("src/systems/trace.ts");

  assert.match(tablet, /beginUiInteraction\(uiButtonId\(elementId\)\)/);
  assert.match(tablet, /private observeUiClick/);
  assert.match(tablet, /this\.observeUiClick\(tablet, id, handler\)/);
  assert.match(tablet, /InteractionStage\.GameplayValidation/);
  assert.match(tablet, /Terminal\.RejectedWithReason/);
  assert.match(correlation, /Do not log the controller ray every frame|Rays and hovers are deliberately not logged/);
  assert.match(correlation, /candidate count.*private to InputSystem/i);
  assert.match(correlation, /function stageMask\(stage: number\)/);
  assert.match(correlation, /traceInteractionTiming\(/);
  assert.match(trace, /export function traceInteractionTiming/);
});

test("Phase 3 keeps the interaction deadline as the missing-terminal safeguard", () => {
  const correlation = source("src/systems/traceInteraction.ts");

  assert.match(correlation, /INTERACTION_DEADLINE_MS/);
  assert.match(correlation, /closeSlot\(slot, Terminal\.Timeout, Reason\.InteractionTimeout, true\)/);
  assert.match(correlation, /clearInteractions\(reason: number\)/);
});
