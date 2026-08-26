import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  VisibilityState,
  createSystem,
  type Entity,
  type Object3D,
} from "@iwsdk/core";
import {
  TUTORIAL_CARD_BACKGROUND,
  TUTORIAL_CARD_BODY_COLOR,
  TUTORIAL_CARD_BORDER,
  TUTORIAL_CARD_DEAD_END_BACKGROUND,
  TUTORIAL_CARD_DEAD_END_BORDER,
  TUTORIAL_CARD_DEAD_END_TITLE_COLOR,
  TUTORIAL_CARD_RECOVERY_BACKGROUND,
  TUTORIAL_CARD_RECOVERY_BORDER,
  TUTORIAL_CARD_RECOVERY_TITLE_COLOR,
  TUTORIAL_CARD_HEIGHT,
  TUTORIAL_CARD_STEP_COLOR,
  TUTORIAL_CARD_TEXTURE_HEIGHT,
  TUTORIAL_CARD_TEXTURE_WIDTH,
  TUTORIAL_CARD_TITLE_COLOR,
  TUTORIAL_CARD_PROGRESS_COLOR,
  TUTORIAL_CARD_DIM_BACKGROUND,
  TUTORIAL_CARD_DIM_BORDER,
  TUTORIAL_CARD_DISTANCE,
  TUTORIAL_CARD_DROP,
  TUTORIAL_CARD_FACING_MIN,
  TUTORIAL_CARD_MAX_DISTANCE,
  TUTORIAL_CARD_MIN_DISTANCE,
  TUTORIAL_CARD_BOARD_CLEARANCE,
  TUTORIAL_CARD_SUBJECT_CLEARANCE,
  TUTORIAL_CARD_TABLET_CLEARANCE,
  TUTORIAL_CARD_TABLET_DEPTH_LIMIT,
  TUTORIAL_CARD_VIEW_ANGLE_MIN,
  TUTORIAL_CARD_WIDTH,
  TUTORIAL_GAZE_DOT_MIN,
  TUTORIAL_ARROW_COMMAND_CENTER_FALLBACK,
  TUTORIAL_ARROW_COMMAND_CENTER_GAP,
  TUTORIAL_ARROW_TABLET_LIFT,
  TUTORIAL_DIM_FACTOR,
  TUTORIAL_RING_DRAIN_RATE,
  TUTORIAL_RING_WEDGES,
  TUTORIAL_SAMPLE_SECONDS,
  TUTORIAL_THREAT_TILE_STEPS,
} from "./constants.ts";
import { GRID_SIZE, gridToWorld, setBoardDim, worldToGrid } from "./board.js";
import { commandCenterHudTopWorldY } from "./commandCenterHud.js";
import { makeNonInteractive } from "./sharedGeometry.js";
import {
  attachTutorialVisualPool,
  createTutorialVisualPool,
  detachTutorialVisualPool,
} from "./tutorialVisualPool.js";
import { liftAboveScene } from "./underAttackBanner.js";
import {
  Building,
  ConstructionSite,
  CraftProductionSite,
  DebugSettings,
  Enemy,
  GameState,
  GameStats,
  Health,
  MatchState,
  MinerState,
  TutorialState,
  Unit,
  UnderAttackAlertState,
  WaveSource,
  WaveUnit,
  boardState,
} from "./state.js";
import { TUTORIAL_WAVE_NUMBER } from "./waveCatalog.js";
import { matchAwaitingStart } from "./matchStart.js";
import { setEnvironmentDim } from "./skySystem.js";
import {
  attachTutorialSpotlight,
  detachTutorialSpotlight,
  clearSpotlightSubject,
  setSpotlightSubject,
  subjectRingRadius,
  subjectTopWorldY,
} from "./tutorialSpotlight.js";
import { setTutorialAllowedKind, setTutorialTabHint } from "./tablet.js";
import {
  clearTutorialLeft,
  clearTutorialWaveGate,
  markTutorialLeft,
  setTutorialWaveGate,
  tutorialRequiresRestart,
  type TutorialSpawnAnchor,
} from "./tutorialWaveGate.js";
import {
  attachTutorialPathWorld,
  detachTutorialPaths,
  clearTutorialPath,
  hideAllTutorialPaths,
  hideTutorialPath,
  showTutorialPath,
  showTutorialRoute,
  tickTutorialPaths,
} from "./tutorialPath.js";
import { setTutorialFreeze } from "./tutorialFreeze.js";
import {
  attachTutorialTurnCue,
  detachTutorialTurnCue,
  clearTutorialTurnCue,
  hideTutorialTurnCue,
  showTutorialTurnCue,
} from "./tutorialTurnCue.js";
import { alienRouteTiles } from "./wave.js";
import {
  attachTutorialRingWorld,
  detachTutorialRing,
  clearTutorialRing,
  hideTutorialRing,
  showTutorialRing,
} from "./tutorialRing.js";
import {
  attachTutorialArrowWorld,
  detachTutorialArrows,
  clearTutorialArrow,
  hideTutorialArrow,
  hideTutorialArrowsFrom,
  showTutorialArrow,
  tickTutorialArrows,
  tutorialArrowCapacity,
} from "./tutorialArrow.js";
import {
  TUTORIAL_DRILLS,
  TUTORIAL_ENABLED,
  type ArrowTarget,
  type DrillPhase,
  type TutorialDrill,
  type TutorialPath,
} from "./tutorialCatalog.ts";
import {
  advanceTutorial,
  arrowProblem,
  arrowTargetsFor,
  canResolveArrow,
  advanceGazeProgress,
  gazeFraction,
  allowedCreateKind,
  cardToneFor,
  recoveryGoal,
  savingProgressLine,
  savingTowardFor,
  tabHintFor,
  interceptTileFor,
  cardBodyFor,
  drillPhase,
  focusRequirement,
  focusTargetFor,
  latchDrillMet,
  latchDrillStarted,
  pathsFor,
  nearestCornerTo,
  releaseBudget,
  tutorialGovernsWaves,
  tutorialHoldsWaveCountdown,
  threatTileFor,
  type TutorialRecovery,
  type TutorialSnapshot,
} from "./tutorialRules.ts";
import { traceStateChange } from "./trace.js";
import { State } from "./traceIds.js";

/**
 * Tutorial runtime — the world-facing half. All decisions live in
 * `tutorialRules.ts`; this samples the world, hands the rules a snapshot, and
 * renders the result.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * Phase 2 scope: the instruction card only. The arrow, the wave gate, wave 0
 * and the bare-start scenario change are later phases, so today the tutorial
 * narrates a normal match rather than directing one.
 */

let cardMesh: Mesh | null = null;
let cardMaterial: MeshBasicMaterial | null = null;
let cardTexture: CanvasTexture | null = null;
let cardContext: CanvasRenderingContext2D | null = null;
/**
 * Anchor + detachable container for the card. See `tutorialVisualPool.ts` for
 * why the mesh is a plain child rather than its own entity.
 */
const cardPool = createTutorialVisualPool("TutorialCard");

/** Index into TUTORIAL_DRILLS; -1 once finished. */
let drillIndex = 0;
/** Kills already banked when the current drill began — see isDrillComplete. */
let killsAtDrillStart = 0;
let sampleClock = 0;
/** Seconds the current drill has been showing — drives the dwell triggers. */
let drillElapsed = 0;
/** Last text painted, so a repaint only happens when the words change. */
let paintedTitle = "";
let paintedBody = "";
/** Last progress line painted, so a ticking crystal count repaints but does not move the card. */
let paintedProgress = "";
/** Card tone last painted, so a colour change repaints even if the words match. */
let paintedTone: "normal" | "recovery" | "deadEnd" = "normal";
/** Last arrow problem reported, so a sustained one logs once, not at 4 Hz. */
let reportedArrowProblem = "";
/**
 * What the arrow is pointing at, chosen by the rules at 4 Hz. The world
 * POSITION is re-resolved every frame from this, so the arrow stays glued to a
 * walking alien rather than lagging it by up to a quarter second.
 */
let activeArrowTargets: readonly ArrowTarget[] = [];
/** The tab currently pulsing, so the hint is only pushed to the tablet on change. */
let activeTabHint: string | null = null;
/** The kind the tablet is currently locked to, so the push happens on change. */
let activeAllowedKind: string | null = null;
/**
 * Whether the current drill has visibly begun. A LATCH, not a live read — see
 * latchDrillStarted. Cleared when the drill changes.
 */
let drillStarted = false;
/**
 * Whether the current drill's meet beat is satisfied. A second latch of the
 * same shape as `drillStarted` — the player has looked at what arrived.
 */
let drillMet = false;
/** The phase the last sample settled on, so per-frame work agrees with it. */
let activePhase: DrillPhase = "intro";
/** Route scratch for the red path — reused, never allocated per frame. */
const routeTiles = Array.from({ length: 64 }, () => ({ x: 0, y: 0 }));
/**
 * Where the first alien lands: the board corner nearest the mine. Resolved once
 * per match from the live board — crystals are hand-placed and never move, so
 * re-deriving it at sample rate would be pure waste.
 */
let spawnAnchor: TutorialSpawnAnchor | null = null;
/**
 * Seconds of accumulated looking for the current drill. Filled and drained per
 * FRAME, not per sample — the ring is the feedback, and 4 Hz would visibly step.
 */
let gazeProgress = 0;
/** Last value mirrored into TutorialState.gaze, to avoid a per-frame ECS write. */
let lastPublishedGaze = -1;
/** Whether the card is currently painted in its dimmed-world palette. */
let cardDimmed = false;
/** Cached nearest-crystal tile; -1 means none. Refreshed at sample rate. */
let crystalTileX = -1;
let crystalTileY = -1;
/** Last published gate values. Gate publication is sampled, not spammed. */
let tracedGateDrill = Number.NaN;
let tracedGateGoverning = false;
let tracedGateHolding = false;
let tracedGateBudget = Number.NaN;

// Reused every sample — never allocated in update().
const snapshot: TutorialSnapshot = {
  selectedUnitCount: 0,
  ordersIssued: 0,
  crystals: 0,
  crystalsMined: 0,
  minerCount: 0,
  astronautCount: 0,
  constructionSiteCount: 0,
  turretCount: 0,
  enemiesKilled: 0,
  liveEnemyCount: 0,
  matchStatus: "playing",
  stepElapsedSeconds: 0,
  alertRevision: 0,
  lookingAtFocus: false,
  gazeProgressSeconds: 0,
  commandCenterAlive: true,
};
const tmpAnchor = new Vector3();
const tmpCamera = new Vector3();
const tmpForward = new Vector3();
const tmpCardWorld = new Vector3();
const tmpToCard = new Vector3();
const tmpArrow = new Vector3();
/** Living Path endpoints. Owner: updatePath. */
const tmpPathFrom = new Vector3();
const tmpPathTo = new Vector3();
/** Reused every sample — the resolvable subset of the drill's declared arrows. */
const resolvableTargets: ArrowTarget[] = [];
/** Where the focus effect is centred. Owner: updateGazeRing. */
const tmpFocus = new Vector3();
/** Whether tmpFocus holds a usable position this frame. */
let focusResolved = false;
/** The card's own facing, for the leash's view-angle check. */
const tmpCardFacing = new Vector3();
const tmpTablet = new Vector3();
const tmpRight = new Vector3();
/** Board-root world position, for the card's ground clamp. */
const tmpBoardTop = new Vector3();
// Scratch for the arrow resolvers. Each has ONE owner, because they nest:
// worldOfInterceptTile holds a unit position while calling worldOfNearestEnemy,
// which needs an anchor and a cursor of its own. Sharing one scratch between
// them silently resolved the intercept arrow from the base instead of the
// miner — a wrong-but-plausible position, which is the worst kind of bug.
/** Cursor inside the nearest-* scan loops. Owner: worldOfNearestUnit/Enemy. */
const tmpScan = new Vector3();
/** What a nearest-* scan measures from. Owner: worldOfNearestUnit/Enemy. */
const tmpFrom = new Vector3();
/** The threatened unit. Owner: worldOfInterceptTile. */
const tmpUnit = new Vector3();
/** What threatens it. Owner: worldOfInterceptTile / incomingEdge. */
const tmpThreat = new Vector3();

/**
 * Is the tutorial switched on right now?
 *
 * Reads `DebugSettings.tutorialEnabled` so the tablet's Settings tab can flip it
 * mid-session, falling back to the `TUTORIAL_ENABLED` default before the
 * singleton exists. Same relationship every other tunable has with its constant
 * (see `ALIEN_MOVE_SPEED` / `DebugSettings.alienMoveSpeed`).
 *
 * Note that `DebugSettings` is deliberately not cleared by scenario reset, so a
 * player who switches the tutorial off keeps it off across Restart within the
 * same session — which is what you want from a debug toggle.
 */
export function isTutorialEnabled(): boolean {
  const setting = boardState.debugSettings?.getValue(
    DebugSettings,
    "tutorialEnabled",
  );
  if (setting === undefined || setting === null) return TUTORIAL_ENABLED;
  return setting >= 0.5;
}

/**
 * Hand the wave system its instructions.
 *
 * Everything here is derived — the budget from the drill list, the hold from
 * whether anything is owed, the anchor from the board. Nothing is tracked
 * separately, so nothing can drift out of step with the script.
 *
 * A module function rather than a method because it has to be callable from
 * `resetTutorial()` and from `init()`, both of which run outside an update.
 * That is not tidiness: **WaveSystem updates before TutorialSystem**, and the
 * wave is prepared exactly once, so a gate published from `update()` alone
 * arrives a frame after the only frame that reads it. The first alien then
 * spawned on the south rim instead of the mine's corner, silently.
 */
export function publishTutorialWaveGate(
  drill: number,
  releaseCurrent: boolean,
): void {
  const budget = releaseBudget(drill, releaseCurrent);
  const governing = tutorialGovernsWaves(isTutorialEnabled(), drill);
  const holdsCountdown = tutorialHoldsWaveCountdown(drill, budget);
  setTutorialWaveGate({
    // A FINISHED tutorial must let go of the wave system entirely. Leaving it
    // governing caps every later wave at the tutorial's own budget of 3.
    governing,
    holdsCountdown,
    releaseBudget: budget,
    spawnAnchor: resolveSpawnAnchor(),
  });
  // WaveSystem runs before TutorialSystem, so this event is the auditable
  // publication point for the initialization/next-frame gate contract. Only
  // changes are recorded: the tutorial samples four times a second.
  if (drill !== tracedGateDrill) {
    traceStateChange(State.TutorialDrill, tracedGateDrill || 0, drill);
    tracedGateDrill = drill;
  }
  if (governing !== tracedGateGoverning) {
    traceStateChange(
      State.TutorialGoverning,
      tracedGateGoverning ? 1 : 0,
      governing ? 1 : 0,
    );
    tracedGateGoverning = governing;
  }
  if (holdsCountdown !== tracedGateHolding) {
    traceStateChange(
      State.TutorialHoldsCountdown,
      tracedGateHolding ? 1 : 0,
      holdsCountdown ? 1 : 0,
    );
    tracedGateHolding = holdsCountdown;
  }
  if (Number.isFinite(budget) && budget !== tracedGateBudget) {
    traceStateChange(
      State.TutorialReleaseBudget,
      Number.isFinite(tracedGateBudget) ? tracedGateBudget : 0,
      budget,
    );
    tracedGateBudget = budget;
  }
}

/**
 * The board corner nearest the mine — see `nearestCornerTo` for the rule.
 *
 * Measured from the nearest crystal to the COMMAND CENTER rather than to the
 * miner: the miner walks, and an anchor that moved would put the alien
 * somewhere different every time the wave was rebuilt. The base does not move.
 *
 * Cached, because both inputs are hand-placed scenario data that never change
 * within a match.
 */
function resolveSpawnAnchor(): TutorialSpawnAnchor | null {
  if (spawnAnchor) return spawnAnchor;
  const base = boardState.commandCenter;
  if (!base) return null;
  const baseX = base.getValue(Building, "x") ?? -1;
  const baseY = base.getValue(Building, "y") ?? -1;
  if (baseX < 0 || baseY < 0) return null;

  let bestDistance = Number.POSITIVE_INFINITY;
  let mineX = -1;
  let mineY = -1;
  for (const [key, terrain] of boardState.terrainByKey) {
    if (terrain !== "crystal") continue;
    const split = key.indexOf(",");
    if (split < 0) continue;
    const x = Number(key.slice(0, split));
    const y = Number(key.slice(split + 1));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const distance = (x - baseX) ** 2 + (y - baseY) ** 2;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    mineX = x;
    mineY = y;
  }
  if (mineX < 0) return null;
  spawnAnchor = nearestCornerTo({ x: mineX, y: mineY }, GRID_SIZE);
  return spawnAnchor;
}

/** Back to drill 1. Called by scenario reset — restart replays the tutorial. */
/**
 * Take every tutorial visual out of the live scene, keeping its GPU resources.
 *
 * The whole lifecycle in one rule: **Finish or Skip removes the visuals from
 * the scene; Restart reuses them.** Nothing is left hidden-but-attached paying
 * traversal, and nothing is duplicated on the next run.
 *
 * Detach rather than dispose, deliberately. The existing `dispose*` functions
 * free geometries and materials, which is right for a genuine teardown and
 * wrong for normal completion: re-creating the effects would pay a fresh
 * allocation and shader-compile hitch on every Restart. `tutorialRing.ts:83-90`
 * records the other half of that trap — the earlier rebuild-per-radius approach
 * leaked entities because `removeFromParent()` detaches the mesh while the ECS
 * entity survives. Pooling under a detachable non-entity group avoids both.
 *
 * Idempotent, so "skip before the tutorial ever drew anything" is a no-op
 * rather than a special case.
 */
export function detachTutorialVisuals(): void {
  detachTutorialVisualPool(cardPool);
  detachTutorialArrows();
  detachTutorialRing();
  detachTutorialPaths();
  detachTutorialTurnCue();
  // Restores the dimmed subject materials before the light leaves, or a model
  // darkened for a focus beat would stay dark for the rest of the match.
  detachTutorialSpotlight();
  setEnvironmentDim(1);
  setBoardDim(1);
}

export function resetTutorial(): void {
  // Restart is the one path that re-arms the tutorial. The pooled visuals
  // re-attach lazily, the first time a drill actually needs each one.
  clearTutorialLeft();
  drillIndex = 0;
  killsAtDrillStart = 0;
  sampleClock = 0;
  drillElapsed = 0;
  paintedTitle = "";
  paintedBody = "";
  paintedProgress = "";
  reportedArrowProblem = "";
  resolvableTargets.length = 0;
  activeArrowTargets = resolvableTargets;
  drillStarted = false;
  drillMet = false;
  activePhase = "intro";
  setTutorialFreeze(false);
  gazeProgress = 0;
  lastPublishedGaze = -1;
  clearTutorialRing();
  clearTutorialTurnCue();
  clearTutorialPath();
  setEnvironmentDim(1);
  setBoardDim(1);
  clearSpotlightSubject();
  focusResolved = false;
  cardDimmed = false;
  spawnAnchor = null;
  // Re-arm the gate NOW, not on the next 4 Hz sample. Two reasons, both real:
  // for that quarter second the old budget would still be live (enough for a
  // restart mid-Act-2 to release an alien the new run has not earned), and the
  // fresh wave is prepared before TutorialSystem's next update, so the spawn
  // anchor has to be in place already.
  publishTutorialWaveGate(0, false);
  crystalTileX = -1;
  crystalTileY = -1;
  clearTutorialArrow();
  // Hand the tab back before the card goes: a pulse left running would outlive
  // the tutorial and leave a tab looking permanently selected.
  if (activeTabHint !== null) {
    activeTabHint = null;
    setTutorialTabHint(null);
  }
  if (activeAllowedKind !== null) {
    activeAllowedKind = null;
    setTutorialAllowedKind(null);
  }
  if (cardMesh) cardMesh.visible = false;
  const state = boardState.tutorial;
  if (!state) return;
  state.setValue(TutorialState, "active", false);
  state.setValue(TutorialState, "drill", -1);
  state.setValue(TutorialState, "recovery", "");
  state.setValue(TutorialState, "deadEnd", false);
  bumpRevision(state);
}

function bumpRevision(state: NonNullable<typeof boardState.tutorial>): void {
  state.setValue(
    TutorialState,
    "revision",
    (state.getValue(TutorialState, "revision") ?? 0) + 1,
  );
}

/**
 * Wrap text to the card width. Called only on a repaint — nine times across an
 * entire tutorial — so measureText per word is affordable here.
 */
function wrapLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Set a font that makes `text` fit `maxWidth`, shrinking from `basePx` if needed.
 *
 * Down to 70% only. Past that the text is small enough that fitting it is no
 * longer the useful outcome — a line that needs more than a third off is a line
 * that should be shorter, and capping the shrink makes that visible instead of
 * silently producing something unreadable.
 */
function fitFont(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  basePx: number,
  weight: string,
): void {
  let size = Math.round(basePx);
  const floor = Math.round(basePx * 0.7);
  for (;;) {
    context.font = `${weight} ${size}px sans-serif`;
    if (context.measureText(text).width <= maxWidth || size <= floor) return;
    size -= 1;
  }
}

function paintCard(
  title: string,
  body: string,
  step: string,
  dimmedWorld: boolean,
  progress: string,
  tone: "normal" | "recovery" | "deadEnd" = "normal",
): void {
  const context = cardContext;
  if (!context || !cardTexture) return;
  const width = TUTORIAL_CARD_TEXTURE_WIDTH;
  const height = TUTORIAL_CARD_TEXTURE_HEIGHT;
  context.clearRect(0, 0, width, height);

  context.beginPath();
  context.roundRect(3, 3, width - 6, height - 6, 22);
  // Brighter panel and border while the world is dimmed. The card is unlit so
  // it never darkens — but a near-black panel against a darkened board recedes
  // instead of standing out, which is the opposite of what the beat wants.
  // Tone outranks the dim. A recovery or a dead end can happen during a frozen
  // beat, and "something has gone wrong" is the more important of the two things
  // the card is saying — so the loss colours win rather than blending.
  context.fillStyle =
    tone === "deadEnd"
      ? TUTORIAL_CARD_DEAD_END_BACKGROUND
      : tone === "recovery"
        ? TUTORIAL_CARD_RECOVERY_BACKGROUND
        : dimmedWorld
          ? TUTORIAL_CARD_DIM_BACKGROUND
          : TUTORIAL_CARD_BACKGROUND;
  context.fill();
  // A thicker rule for both loss states: the border is the part read at a
  // glance, before any of the words.
  context.lineWidth = tone !== "normal" ? 7 : dimmedWorld ? 6 : 4;
  context.strokeStyle =
    tone === "deadEnd"
      ? TUTORIAL_CARD_DEAD_END_BORDER
      : tone === "recovery"
        ? TUTORIAL_CARD_RECOVERY_BORDER
        : dimmedWorld
          ? TUTORIAL_CARD_DIM_BORDER
          : TUTORIAL_CARD_BORDER;
  context.stroke();

  const pad = width * 0.045;
  context.textBaseline = "top";
  context.textAlign = "left";

  context.font = `600 ${Math.round(height * 0.13)}px sans-serif`;
  context.fillStyle = TUTORIAL_CARD_STEP_COLOR;
  context.fillText(step, pad, height * 0.11);

  context.font = `bold ${Math.round(height * 0.2)}px sans-serif`;
  context.fillStyle =
    tone === "deadEnd"
      ? TUTORIAL_CARD_DEAD_END_TITLE_COLOR
      : tone === "recovery"
        ? TUTORIAL_CARD_RECOVERY_TITLE_COLOR
        : TUTORIAL_CARD_TITLE_COLOR;
  context.fillText(title, pad, height * 0.26);

  context.font = `${Math.round(height * 0.128)}px sans-serif`;
  context.fillStyle = TUTORIAL_CARD_BODY_COLOR;
  let y = height * 0.46;
  for (const line of wrapLines(context, body, width - pad * 2)) {
    context.fillText(line, pad, y);
    y += height * 0.16;
  }

  // "Why am I hoarding crystals?" — answered on the card rather than left to
  // the player to work out from the tablet.
  if (progress) {
    // Fitted, not assumed to fit. This line is the longest thing on the card and
    // the only one that is not wrapped — "60 crystals banked - you can build a
    // Mining Craft now" ran off the right edge and lost its last word, which is
    // the word that says you can act. Shrinking to fit keeps it one line, which
    // is what makes it readable as a status rather than as more body text.
    context.fillStyle = TUTORIAL_CARD_PROGRESS_COLOR;
    fitFont(context, progress, width - pad * 2, height * 0.118, "600");
    context.fillText(progress, pad, height * 0.845);
  }

  cardTexture.needsUpdate = true;
}

export class TutorialSystem extends createSystem({
  units: { required: [Unit, Health] },
  buildings: { required: [Building, Health] },
  sites: { required: [ConstructionSite] },
  craftSites: { required: [CraftProductionSite] },
  enemies: { required: [Enemy, Health] },
}) {
  init(): void {
    const state = this.world
      .createTransformEntity(undefined, { persistent: true })
      .addComponent(TutorialState);
    state.object3D!.name = "TutorialState";
    boardState.tutorial = state;
    // The arrow lives in its own module but must be a real entity, not a bare
    // add() onto the board root — same reason combatEffects captures a world.
    attachTutorialArrowWorld(this.world);
    attachTutorialRingWorld(this.world);
    attachTutorialSpotlight(this.world);
    attachTutorialPathWorld(this.world);
    attachTutorialTurnCue(this.world);

    // Visibility only decides whether the tutorial is active; it never restarts
    // it. Quest can report removing and replacing the headset as a brief
    // NonImmersive -> Visible transition, so that transition is not a reliable
    // signal that the player chose to replay the match. ScenarioResetSystem is
    // the sole owner of a deliberate tutorial restart.
    // Claim the tutorial level for this run. Done here rather than in
    // BoardSystem because `boardState.waveSource` has to exist first, and
    // TutorialSystem is registered after it.
    //
    // Deliberately NOT gated on being in VR: the card is a VR experience, the
    // *level* is not. If the match sat at wave 1 in the preview and only became
    // wave 0 on entering XR, the player would put the headset on mid-wave.
    this.claimTutorialLevel();
    // Before the first update of ANY system: WaveSystem runs earlier in the
    // frame and prepares the wave once, so the anchor must already be published.
    publishTutorialWaveGate(drillIndex, false);
  }

  update(delta: number): void {
    // The tutorial is a VR experience and only runs in one.
    //
    // In the 2D preview the camera already faces the base, so it would advance
    // through orientation and into mining before anyone puts the headset on —
    // and the card is placed relative to a viewpoint the player will never
    // occupy. Running it there teaches nobody and only burns the script.
    //
    // VisibleBlurred (headset off the face, or focus lost) is deliberately
    // excluded too: nothing should advance while the player cannot see it.
    if (this.world.visibilityState.peek() !== VisibilityState.Visible) {
      // Dormant. Whether it also HOLDS THE WAVES depends on whether the match
      // has begun, and the distinction is the whole rule for desktop play:
      //
      //  - **Not started yet** (`awaiting-start`) — hold. A tutorial run waiting
      //    in the 2D preview must keep its waves frozen, or the player puts the
      //    headset on to find wave 0 already half-spawned and the script
      //    skipped. (The start gate freezes them too; this is belt and braces.)
      //  - **Started on desktop** — release. The tutorial is VR-only, so it can
      //    never run here, and a holder that cannot run is a deadlock: the
      //    countdown pins at TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS forever and
      //    the match never progresses. Measured 2026-08-26: wave 0 stuck at
      //    `timer: 2` indefinitely with 3 aliens prepared and never released.
      //
      // Releasing also retires the tutorial for this match (`goDormant(false)`
      // marks it left), so putting the headset on mid-match does not drop the
      // player into drill 1 of a game already underway — they are told to
      // Restart, which is the existing re-arm path.
      this.goDormant(isTutorialEnabled() && matchAwaitingStart());
      return;
    }
    if (!isTutorialEnabled()) {
      this.goDormant(false);
      return;
    }
    // Switched back on after finishing or skipping. Hold dormant rather than
    // re-entering the script mid-match; the tablet tells the player that a
    // Restart is what starts it. `goDormant(false)` is idempotent.
    if (tutorialRequiresRestart()) {
      this.goDormant(false);
      return;
    }
    // Finished. `evaluate()` already detached the visuals and released the wave
    // gate; without this the card, arrow, ring and path checks kept running
    // every frame for the rest of the match, which is what made "tutorial over"
    // still cost something.
    if (drillIndex < 0) return;
    if (!this.ensureCard()) return;

    // 4 Hz. Nothing here needs frame-rate responsiveness, and the counts below
    // are the only mildly expensive reads.
    const step = Math.max(0, delta);
    drillElapsed += step;
    sampleClock += step;
    if (sampleClock >= TUTORIAL_SAMPLE_SECONDS) {
      sampleClock = 0;
      this.evaluate();
    }
    this.keepCardInView();
    // Every frame, not every sample: the arrow tracks a walking alien, and at
    // 4 Hz it would visibly stutter behind one.
    this.updateArrow(step);
    this.updateGazeRing(step);
    this.updatePath(step);
  }

  /**
   * Draw the miner's journey while the mining drill is running.
   *
   * Two cases, and the distinction matters (see "forecast or instruction?" in
   * the plan):
   *
   *  - **Forecast** — the miner is walking. The path must match where it will
   *    actually go, which for a friendly unit is a straight line, because
   *    `MovementSystem` interpolates straight at the order tile.
   *  - **Instruction** — the miner is idle and the player has not ordered it
   *    yet. The path then says "send it there", which predicts nothing, so a
   *    straight line is simply correct.
   *
   * Standing still mid-cycle (gathering, depositing) gets no path: there is no
   * journey to describe, and chevrons under a stationary unit read as a glitch.
   */
  private updatePath(delta: number): void {
    tickTutorialPaths(delta);
    const drill = drillIndex >= 0 ? TUTORIAL_DRILLS[drillIndex] : undefined;
    if (!drill) {
      hideAllTutorialPaths();
      return;
    }
    let drewFriendly = false;
    let drewHostile = false;
    for (const path of pathsFor(drill, activePhase)) {
      if (!this.drawPath(path)) continue;
      if (path.style === "hostile") drewHostile = true;
      else drewFriendly = true;
    }
    if (!drewFriendly) hideTutorialPath("friendly");
    if (!drewHostile) hideTutorialPath("hostile");
  }

  /** One path. Returns whether anything was actually drawn. */
  private drawPath(path: TutorialPath): boolean {
    if (!this.resolveArrowTarget(path.from, tmpPathFrom)) return false;

    // A hostile path follows the alien's REAL route — it is a forecast, and
    // aliens genuinely walk around obstacles, so a straight line would draw a
    // route they will not take. Re-read every frame: routes are re-derived
    // periodically, and a cached one points confidently through a wall.
    if (path.style === "hostile") {
      const alien = this.nearestEnemyEntity();
      if (alien) {
        const count = alienRouteTiles(alien.index, routeTiles);
        if (count > 0) {
          showTutorialRoute("hostile", tmpPathFrom, routeTiles, count);
          return true;
        }
      }
    }

    // Friendly units move straight at their order tile, so a segment is correct
    // rather than a compromise. Also the fallback for an alien with no route
    // yet — a straight hint beats nothing.
    if (!this.resolveArrowTarget(path.to, tmpPathTo)) return false;
    showTutorialPath(path.style, tmpPathFrom, tmpPathTo);
    return true;
  }

  private nearestEnemyEntity(): Entity | null {
    if (!this.worldOfEntity(boardState.commandCenter, tmpFrom)) {
      this.camera.getWorldPosition(tmpFrom);
    }
    let best = Number.POSITIVE_INFINITY;
    let found: Entity | null = null;
    for (const enemy of this.queries.enemies.entities) {
      if (!this.isEnemyOnBoard(enemy)) continue;
      const object = enemy.object3D;
      if (!object) continue;
      object.getWorldPosition(tmpScan);
      const distance = tmpScan.distanceToSquared(tmpFrom);
      if (distance >= best) continue;
      best = distance;
      found = enemy;
    }
    return found;
  }


  /**
   * Fill the gaze ring while the player is on target, drain it when they are
   * not, and park it for drills that do not gate on looking.
   *
   * Per frame, not per sample. This is the one piece of tutorial feedback where
   * 4 Hz would be visible — a ring that steps in quarter-second jumps reads as
   * a stutter rather than as a fill.
   */
  private updateGazeRing(delta: number): void {
    const drill = drillIndex >= 0 ? TUTORIAL_DRILLS[drillIndex] : undefined;
    const target = drill ? focusTargetFor(drill, activePhase) : null;
    // A meet beat holds the world still; a `lookedAt` beat has nothing to hold.
    const freezing = activePhase === "meet" && !!drill?.meet;
    // Once a meet beat is satisfied the focus lifts entirely — the drill has
    // moved on to "now deal with it", and a ring still burning on the alien
    // would be telling the player to keep looking instead of acting.
    const finishedMeeting = activePhase === "doing" && !!drill?.meet;
    if (!drill || !target || finishedMeeting) {
      gazeProgress = 0;
      focusResolved = false;
      hideTutorialRing();
      hideTutorialTurnCue();
      this.publishGaze(0);
      this.clearFocus();
      return;
    }

    // ONE resolution serves all three effects — the light, the ring and the
    // gaze test — so they cannot end up pointed at different things.
    focusResolved = this.resolveArrowTarget(target, tmpFocus);
    const subject = this.objectOfArrowTarget(target);

    this.setWorldDim(TUTORIAL_DIM_FACTOR);
    setSpotlightSubject(subject, focusResolved ? tmpFocus : null, 1);
    // The freeze ends when the ring fills — a gate the player releases by
    // looking, not a cutscene that ends on a timer.
    setTutorialFreeze(freezing);

    const required = focusRequirement(drill, activePhase);
    gazeProgress = advanceGazeProgress(
      gazeProgress,
      this.isLookingAt(focusResolved ? tmpFocus : null),
      delta,
      required,
      TUTORIAL_RING_DRAIN_RATE,
    );

    if (!focusResolved) {
      hideTutorialRing();
      hideTutorialTurnCue();
      return;
    }
    const fraction = gazeFraction(gazeProgress, required);
    showTutorialRing(tmpFocus, fraction, subjectRingRadius(subject));
    this.publishGaze(fraction);

    // "It is behind you." A ring on something outside the player's view teaches
    // nothing, so point them at it until it is in front of them.
    this.camera.getWorldPosition(tmpCamera);
    this.camera.getWorldDirection(tmpForward);
    showTutorialTurnCue(tmpCamera, tmpForward, tmpFocus, delta);
  }

  /** Restore the world and drop the focus. Idempotent. */
  private clearFocus(): void {
    this.setWorldDim(1);
    setSpotlightSubject(null, null, 0);
    // Whoever freezes must thaw. This path is taken on dormancy, on the
    // settings toggle and on restart — every way of leaving a meet beat
    // without finishing it.
    setTutorialFreeze(false);
  }

  /**
   * The Object3D behind an arrow target, when there is one.
   *
   * Tile targets have no object — the light still goes to the position, but
   * there are no materials to brighten. That is correct: a tile is ground.
   */
  private objectOfArrowTarget(target: ArrowTarget): Object3D | null {
    switch (target.kind) {
      case "commandCenter":
        return boardState.commandCenter?.object3D ?? null;
      case "nearestUnit":
        return this.nearestUnitObject(target.unit);
      case "nearestEnemy":
        return this.nearestEnemyObject();
      default:
        return null;
    }
  }

  private nearestUnitObject(kind: string): Object3D | null {
    this.camera.getWorldPosition(tmpCamera);
    let best = Number.POSITIVE_INFINITY;
    let found: Object3D | null = null;
    for (const unit of this.queries.units.entities) {
      if ((unit.getValue(Health, "current") ?? 0) <= 0) continue;
      if (unit.getValue(Unit, "kind") !== kind) continue;
      const object = unit.object3D;
      if (!object) continue;
      object.getWorldPosition(tmpScan);
      const distance = tmpScan.distanceToSquared(tmpCamera);
      if (distance >= best) continue;
      best = distance;
      found = object;
    }
    return found;
  }

  private nearestEnemyObject(): Object3D | null {
    if (!this.worldOfEntity(boardState.commandCenter, tmpFrom)) {
      this.camera.getWorldPosition(tmpFrom);
    }
    let best = Number.POSITIVE_INFINITY;
    let found: Object3D | null = null;
    for (const enemy of this.queries.enemies.entities) {
      if (!this.isEnemyOnBoard(enemy)) continue;
      const object = enemy.object3D;
      if (!object) continue;
      object.getWorldPosition(tmpScan);
      const distance = tmpScan.distanceToSquared(tmpFrom);
      if (distance >= best) continue;
      best = distance;
      found = object;
    }
    return found;
  }

  /**
   * Mirror the ring's fill into TutorialState.
   *
   * Quantised to the wedge count before comparing, so a continuously changing
   * float does not write to ECS every frame — the value only moves when the
   * ring visibly does.
   */
  /**
   * Dim the world, both halves of it.
   *
   * The lit GLTF models respond to the sun; the board's ground, rim and dust are
   * `MeshBasicMaterial` and ignore lights entirely. Dimming only the sun moved
   * the measured ground brightness by **1.4%** — which is why this is two calls
   * and not one.
   */
  private setWorldDim(factor: number): void {
    setEnvironmentDim(factor);
    setBoardDim(factor);
    // The subject of the beat gets BRIGHTER as its surroundings fall away. A
    // dim that darkens the thing the player is being told to look at is only
    // half the idea.
    const dimmed = factor < 1;
    if (dimmed !== cardDimmed) {
      cardDimmed = dimmed;
      // Force the next evaluate() to repaint in the other palette.
      paintedTitle = "";
      paintedBody = "";
    }
  }

  private publishGaze(fraction: number): void {
    const state = boardState.tutorial;
    if (!state) return;
    const stepped =
      Math.round(fraction * TUTORIAL_RING_WEDGES) / TUTORIAL_RING_WEDGES;
    if (stepped === lastPublishedGaze) return;
    lastPublishedGaze = stepped;
    state.setValue(TutorialState, "gaze", stepped);
  }

  /**
   * Point the arrow at whatever the current drill declared, or park it.
   *
   * Resolution is per frame because most targets move. The decision of WHICH
   * target — that is the rules layer's, and it only changes when the drill or
   * its phase does.
   */
  private updateArrow(delta: number): void {
    tickTutorialArrows(delta);
    let slot = 0;
    for (const target of activeArrowTargets) {
      if (slot >= tutorialArrowCapacity()) break;
      if (!this.resolveArrowTarget(target, tmpArrow)) continue;
      showTutorialArrow(slot, tmpArrow);
      slot += 1;
    }
    // Park whatever this drill did not use, so a cone from a previous drill
    // cannot be left hanging over something no longer relevant.
    hideTutorialArrowsFrom(slot);
  }

  /**
   * World position for an arrow target. False means "nothing to point at",
   * which the caller turns into no arrow at all — an arrow aimed at nothing is
   * worse than no arrow, because the card still has words.
   */
  private resolveArrowTarget(target: ArrowTarget, out: Vector3): boolean {
    switch (target.kind) {
      case "commandCenter": {
        // Above the LEVEL/TROOPS/GEMS strip, not at the base's origin — that
        // origin is the building's foot, so the cone ended up inside it.
        if (!this.worldOfEntity(boardState.commandCenter, out)) return false;
        const stripTop = commandCenterHudTopWorldY();
        out.y =
          stripTop === null
            ? out.y + TUTORIAL_ARROW_COMMAND_CENTER_FALLBACK
            : stripTop + TUTORIAL_ARROW_COMMAND_CENTER_GAP;
        return true;
      }
      case "nearestUnit":
        if (!this.worldOfNearestUnit(target.unit, out)) return false;
        this.raiseToSubjectTop(this.nearestUnitObject(target.unit), out);
        return true;
      case "nearestCrystal":
        return this.worldOfNearestCrystal(out);
      case "nearestEnemy":
        if (!this.worldOfNearestEnemy(out)) return false;
        this.raiseToSubjectTop(this.nearestEnemyObject(), out);
        return true;
      case "tile":
        return this.worldOfTile(target.x, target.y, out);
      case "tabletTab": {
        // The pulse is the real cue; the arrow just says which way to look for
        // a tablet that may be over the player's shoulder. Lifted clear of the
        // panel's top edge — `boardState.tablet` is its centre, and a cone
        // parked there covers the very UI it is pointing you at.
        if (!this.worldOfEntity(boardState.tablet, out)) return false;
        out.y += TUTORIAL_ARROW_TABLET_LIFT;
        return true;
      }
      case "threatTile":
        return this.worldOfThreatTile(out);
      case "interceptTile":
        return this.worldOfInterceptTile(out);
      case "unitDestination":
        return this.worldOfUnitDestination(target.unit, out);
    }
  }

  /**
   * Where a unit is currently headed, or false if it is going nowhere.
   *
   * Two sources, in priority order:
   *
   *  1. An explicit order (`Unit.orderX/orderY`) — works for every unit type.
   *  2. A miner's mining cycle, which moves it without an order the player
   *     gave: out to `approachX/Y`, back to `depositX/Y`. Standing still
   *     mid-cycle (gathering, depositing) resolves to nothing, because there is
   *     no journey to draw and a path under a stationary unit reads as a glitch.
   *
   * Deliberately general rather than miner-specific: one declaration then
   * serves "the miner shuttles to the crystals" and "your astronaut is walking
   * to the tile you picked" alike.
   */
  private worldOfUnitDestination(kind: string, out: Vector3): boolean {
    const unit = this.nearestUnitEntity(kind);
    if (!unit) return false;
    if (unit.getValue(Unit, "hasOrder") ?? false) {
      const x = unit.getValue(Unit, "orderX") ?? -1;
      const y = unit.getValue(Unit, "orderY") ?? -1;
      if (x >= 0 && y >= 0) return this.worldOfTile(x, y, out);
    }
    if (!unit.hasComponent(MinerState)) return false;
    const stage = unit.getValue(MinerState, "stage") ?? "idle";
    const field = stage === "toResource" ? "approach" : stage === "toBase" ? "deposit" : null;
    if (!field) return false;
    const x = unit.getValue(MinerState, `${field}X` as "approachX") ?? -1;
    const y = unit.getValue(MinerState, `${field}Y` as "approachY") ?? -1;
    if (x < 0 || y < 0) return false;
    return this.worldOfTile(x, y, out);
  }

  private nearestUnitEntity(kind: string): Entity | null {
    for (const unit of this.queries.units.entities) {
      if ((unit.getValue(Health, "current") ?? 0) <= 0) continue;
      if (unit.getValue(Unit, "kind") === kind) return unit;
    }
    return null;
  }

  /**
   * Lift a resolved point to the top of its subject's bounds.
   *
   * Entity origins sit at a model's feet, and a flier's visual is lifted off
   * its origin as well — so a cone placed at the origin ends up inside the
   * body. No-op when there is nothing to measure (tile targets are ground).
   */
  private raiseToSubjectTop(subject: Object3D | null, out: Vector3): void {
    const top = subjectTopWorldY(subject);
    if (top !== null && top > out.y) out.y = top;
  }

  private worldOfEntity(
    entity: { object3D?: Object3D | null } | null,
    out: Vector3,
  ): boolean {
    const object = entity?.object3D ?? null;
    if (!object) return false;
    object.getWorldPosition(out);
    return true;
  }

  /** Board tile -> world. `gridToWorld` is board-root local, so convert up. */
  private worldOfTile(x: number, y: number, out: Vector3): boolean {
    const rootObject = boardState.boardRoot?.object3D;
    if (!rootObject) return false;
    const [localX, localZ] = gridToWorld(x, y);
    out.set(localX, 0, localZ);
    rootObject.localToWorld(out);
    return true;
  }

  /**
   * Nearest live unit of a kind — measured from the VIEWER, not the base.
   *
   * The arrow's job is to be found, so the one nearest the player is the one
   * they can act on with the shortest look.
   */
  private worldOfNearestUnit(kind: string, out: Vector3): boolean {
    this.camera.getWorldPosition(tmpCamera);
    let best = Number.POSITIVE_INFINITY;
    let found = false;
    for (const unit of this.queries.units.entities) {
      if ((unit.getValue(Health, "current") ?? 0) <= 0) continue;
      if (unit.getValue(Unit, "kind") !== kind) continue;
      const object = unit.object3D;
      if (!object) continue;
      object.getWorldPosition(tmpScan);
      const distance = tmpScan.distanceToSquared(tmpCamera);
      if (distance >= best) continue;
      best = distance;
      out.copy(tmpScan);
      found = true;
    }
    return found;
  }

  /**
   * Nearest crystal patch to the MINER, not to the player.
   *
   * The instruction is "send your miner there", so the useful patch is the one
   * the miner can reach soonest. Falls back to the viewer when there is no
   * miner — the recovery case, where the player is about to make one.
   *
   * Resolved at the 4 Hz sample and cached, not per frame: this is the only
   * arrow target that scans all 576 terrain entries, and crystals do not move.
   * The other targets are cheap and stay per-frame so they track.
   */
  private worldOfNearestCrystal(out: Vector3): boolean {
    if (crystalTileX < 0) return false;
    return this.worldOfTile(crystalTileX, crystalTileY, out);
  }

  /** Re-pick the crystal patch the arrow points at. Called at sample rate. */
  private refreshNearestCrystal(): void {
    crystalTileX = -1;
    crystalTileY = -1;
    const rootObject = boardState.boardRoot?.object3D;
    if (!rootObject) return;
    if (!this.worldOfNearestUnit("miner", tmpFrom)) {
      this.camera.getWorldPosition(tmpFrom);
    }
    rootObject.worldToLocal(tmpFrom);

    let best = Number.POSITIVE_INFINITY;
    for (const [key, terrain] of boardState.terrainByKey) {
      if (terrain !== "crystal") continue;
      // `gridKey` is `${x},${y}` — see state.ts. Parsed rather than kept as a
      // parallel list so there is one source of truth for the board's terrain.
      const split = key.indexOf(",");
      if (split < 0) continue;
      const x = Number(key.slice(0, split));
      const y = Number(key.slice(split + 1));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const [localX, localZ] = gridToWorld(x, y);
      const dx = localX - tmpFrom.x;
      const dz = localZ - tmpFrom.z;
      const distance = dx * dx + dz * dz;
      if (distance >= best) continue;
      best = distance;
      crystalTileX = x;
      crystalTileY = y;
    }
  }

  /**
   * Is this enemy actually ON the board?
   *
   * A wave's reserve is alive but `waiting` — built during the countdown,
   * detached and invisible until released. Counting reserves as "the nearest
   * enemy" pointed the meet beat's ring, and the red route, at the mech waiting
   * on the south rim instead of the alien that had just landed.
   *
   * Same class of bug as the tablet's `Enemies alive`, and the same rule: alive
   * AND released.
   */
  private isEnemyOnBoard(enemy: Entity): boolean {
    if ((enemy.getValue(Health, "current") ?? 0) <= 0) return false;
    if (
      enemy.hasComponent(WaveUnit) &&
      enemy.getValue(WaveUnit, "stage") === "waiting"
    ) {
      return false;
    }
    return true;
  }

  /** Nearest released enemy to the base — the one that matters. */
  private worldOfNearestEnemy(out: Vector3): boolean {
    if (!this.worldOfEntity(boardState.commandCenter, tmpFrom)) {
      this.camera.getWorldPosition(tmpFrom);
    }
    let best = Number.POSITIVE_INFINITY;
    let found = false;
    for (const enemy of this.queries.enemies.entities) {
      if (!this.isEnemyOnBoard(enemy)) continue;
      const object = enemy.object3D;
      if (!object) continue;
      object.getWorldPosition(tmpScan);
      const distance = tmpScan.distanceToSquared(tmpFrom);
      if (distance >= best) continue;
      best = distance;
      out.copy(tmpScan);
      found = true;
    }
    return found;
  }

  /**
   * The tile the turret drill points at: the base, stepped toward where the
   * attack is coming from.
   *
   * The live enemy wins over the drill's declared edge whenever there is one —
   * the declared edge is what the catalog *intends*, and `farFromMiner`
   * resolves at release time, so only the board knows the truth.
   */
  private worldOfThreatTile(out: Vector3): boolean {
    const base = boardState.commandCenter;
    if (!base) return false;
    const baseX = base.getValue(Building, "x") ?? -1;
    const baseY = base.getValue(Building, "y") ?? -1;
    if (baseX < 0 || baseY < 0) return false;

    const edge = this.incomingEdge(baseX, baseY);
    const tile = threatTileFor(
      { x: baseX, y: baseY },
      edge,
      TUTORIAL_THREAT_TILE_STEPS,
      GRID_SIZE,
    );
    return this.worldOfTile(tile.x, tile.y, out);
  }

  /**
   * Which board edge the threat is on. Derived from the nearest live enemy's
   * offset from the base — whichever axis it is furthest along — falling back
   * to the current drill's declared spawn edge before anything has spawned.
   */
  private incomingEdge(baseX: number, baseY: number): string {
    const drill = drillIndex >= 0 ? TUTORIAL_DRILLS[drillIndex] : undefined;
    const declared = drill?.opponent?.spawn;
    if (!this.worldOfNearestEnemy(tmpThreat)) {
      // "farFromMiner" is not an edge; it resolves at release time, so before
      // release there is genuinely nothing better than the board's south rim.
      return declared && declared !== "farFromMiner" ? declared : "south";
    }
    const rootObject = boardState.boardRoot?.object3D;
    if (!rootObject) return "south";
    rootObject.worldToLocal(tmpThreat);
    const [baseLocalX, baseLocalZ] = gridToWorld(baseX, baseY);
    const dx = tmpThreat.x - baseLocalX;
    const dz = tmpThreat.z - baseLocalZ;
    if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "east" : "west";
    return dz >= 0 ? "south" : "north";
  }

  /** Between the threatened miner and whatever is coming for it. */
  private worldOfInterceptTile(out: Vector3): boolean {
    const rootObject = boardState.boardRoot?.object3D;
    if (!rootObject) return false;
    if (!this.worldOfNearestUnit("miner", tmpUnit)) return false;
    if (!this.worldOfNearestEnemy(tmpThreat)) return false;

    rootObject.worldToLocal(tmpUnit);
    rootObject.worldToLocal(tmpThreat);
    const [unitX, unitY] = worldToGrid(tmpUnit.x, tmpUnit.z);
    const [threatX, threatY] = worldToGrid(tmpThreat.x, tmpThreat.z);
    const tile = interceptTileFor(
      { x: unitX, y: unitY },
      { x: threatX, y: threatY },
      GRID_SIZE,
    );
    return this.worldOfTile(tile.x, tile.y, out);
  }

  /**
   * Re-place the card only when it has drifted out of comfortable view.
   *
   * The card is normally placed once per text change and left alone — a panel
   * welded to the head is hard to read and impossible to ignore. But "once per
   * text change" alone is not enough: entering XR moves the viewpoint from the
   * desktop preview camera (outside the board) to the XR origin (board centre),
   * several metres in a single frame, with no text change to trigger a re-place.
   * The card would simply be left behind — which is exactly what happened.
   *
   * So: leave it alone while the viewer is near it and facing it; otherwise
   * bring it back. Handles entering XR, walking away, and turning around.
   */
  private keepCardInView(): void {
    const mesh = cardMesh;
    if (!mesh?.visible) return;

    this.camera.getWorldPosition(tmpCamera);
    mesh.getWorldPosition(tmpCardWorld);

    tmpToCard.copy(tmpCardWorld).sub(tmpCamera);
    const distance = tmpToCard.length();
    if (distance > TUTORIAL_CARD_MAX_DISTANCE || distance < TUTORIAL_CARD_MIN_DISTANCE) {
      this.placeCard();
      return;
    }

    this.camera.getWorldDirection(tmpForward);
    tmpForward.y = 0;
    tmpToCard.y = 0;
    if (tmpForward.lengthSq() < 1e-6 || tmpToCard.lengthSq() < 1e-6) return;
    tmpForward.normalize();
    tmpToCard.normalize();
    if (tmpForward.dot(tmpToCard) < TUTORIAL_CARD_FACING_MIN) {
      this.placeCard();
      return;
    }

    // And how far the card is turned AWAY from the viewer — which the three
    // checks above do not ask. All of them are about where the card IS; none is
    // about which way it faces. On Quest that gap showed up as a card sitting
    // obediently in front of the player and edge-on to them, because they had
    // walked around it without ever pushing it out of the tested cone.
    mesh.getWorldDirection(tmpCardFacing);
    tmpCardFacing.y = 0;
    if (tmpCardFacing.lengthSq() < 1e-6) return;
    tmpCardFacing.normalize();
    // `tmpToCard` points camera -> card, and the card's normal points back at
    // the viewer, so a well-faced card gives dot == -1 and an edge-on one gives
    // 0. Hence the negation — comparing the raw dot against a positive
    // threshold is true even when the card is perfectly square to the viewer,
    // which re-places every frame and welds the card to the player's head.
    if (-tmpCardFacing.dot(tmpToCard) < TUTORIAL_CARD_VIEW_ANGLE_MIN) {
      this.placeCard();
    }
  }

  /**
   * Park the card and mark the singleton inactive — once, not per frame.
   *
   * The flag matters beyond tidiness: `TutorialState` is what anyone inspecting
   * a live session reads, and leaving `active: true` while nothing is running
   * would send them looking for a bug that is not there.
   */
  private goDormant(stillHoldingWaves = false): void {
    if (stillHoldingWaves) {
      publishTutorialWaveGate(drillIndex, false);
    } else {
      clearTutorialWaveGate();
    }
    if (cardMesh?.visible) cardMesh.visible = false;
    // The pointing layer has to go with the card, or a dormant tutorial leaves
    // an arrow hanging over the board and a tab lit that nothing will clear.
    resolvableTargets.length = 0;
    activeArrowTargets = resolvableTargets;
    hideTutorialArrow();
    hideTutorialRing();
    hideTutorialTurnCue();
    hideAllTutorialPaths();
    // `stillHoldingWaves` false means the tutorial is switched OFF, which is
    // the skip case: detach, do not merely hide. When it is true the headset
    // is simply off the face and the player is coming back to a live run, so
    // hiding is right and detaching would cost a re-attach on their return.
    if (!stillHoldingWaves) {
      markTutorialLeft();
      detachTutorialVisuals();
    }
    // Dormant means the headset is off or the tutorial is disabled — either way
    // the player must not be left in a darkened world with no explanation.
    this.setWorldDim(1);
    this.setTabHint(null);
    this.setAllowedKind(null);
    const state = boardState.tutorial;
    if (!state) return;
    if (!(state.getValue(TutorialState, "active") ?? false)) return;
    state.setValue(TutorialState, "active", false);
    bumpRevision(state);
  }

  /**
   * Start this match at wave 0 — the tutorial's own level.
   *
   * `WaveSource.waveNumber` defaulting to 1 is what keeps the wave-0 spec inert
   * while the tutorial is off: nothing reaches it unless something deliberately
   * sets 0, and this is the only place that does. `spawnedWaveNumber` is pushed
   * off 0 too, since 0 is now a real wave and would otherwise read as
   * "already spawned".
   */
  private claimTutorialLevel(): void {
    if (!isTutorialEnabled()) return;
    const source = boardState.waveSource;
    if (!source) return;
    if ((source.getValue(WaveSource, "waveNumber") ?? 1) === TUTORIAL_WAVE_NUMBER) {
      return;
    }
    source.setValue(WaveSource, "waveNumber", TUTORIAL_WAVE_NUMBER);
    source.setValue(WaveSource, "spawnedWaveNumber", -1);
    source.setValue(WaveSource, "stage", "countdown");
    source.setValue(
      WaveSource,
      "revision",
      (source.getValue(WaveSource, "revision") ?? 0) + 1,
    );
  }

  private evaluate(): void {
    this.fillSnapshot();
    const before = drillIndex;
    const progress = advanceTutorial(drillIndex, snapshot, killsAtDrillStart);

    if (progress.advanced) {
      drillIndex = progress.drill;
      killsAtDrillStart = snapshot.enemiesKilled;
      // A new drill starts its own dwell clock, its own started latch, and its
      // own gaze ring.
      drillElapsed = 0;
      drillStarted = false;
      drillMet = false;
      gazeProgress = 0;
    }

    // Before anything visual: the wave system reads this, and it must reflect
    // the drill we just advanced to rather than the previous one.
    publishTutorialWaveGate(progress.drill, progress.releaseOpponent);

    const state = boardState.tutorial;
    const active = progress.drill >= 0;
    if (cardMesh) cardMesh.visible = active;

    if (!active) {
      resolvableTargets.length = 0;
      activeArrowTargets = resolvableTargets;
      this.setTabHint(null);
      this.setAllowedKind(null);
      // The script is over: take the visuals out of the scene rather than
      // leaving them hidden-but-attached paying traversal for the rest of the
      // match. Restart re-attaches this same set.
      markTutorialLeft();
      detachTutorialVisuals();
      if (state && (state.getValue(TutorialState, "active") ?? false)) {
        state.setValue(TutorialState, "active", false);
        state.setValue(TutorialState, "drill", -1);
        bumpRevision(state);
      }
      return;
    }

    const drill = TUTORIAL_DRILLS[progress.drill];
    drillStarted = latchDrillStarted(drill, snapshot, drillStarted);
    // The meet latch closes when the gaze ring fills, which is also what lifts
    // the freeze — one condition, so the two can never disagree.
    drillMet = latchDrillMet(drill, gazeProgress, drillMet);
    activePhase = drillPhase(drill, drillStarted, drillMet);
    let title: string;
    let body: string;
    if (progress.deadEnd) {
      title = "Tutorial over";
      body = snapshot.commandCenterAlive
        ? "Your mining craft was lost and there is nothing left to rebuild it with. Restart to try again."
        : "Your command center is gone. Restart to try again.";
    } else if (progress.recovery) {
      title = progress.recovery.unit === "miner" ? "Rebuild your miner" : "Rebuild your astronaut";
      body = progress.recovery.affordable
        ? progress.recovery.unit === "miner"
          ? "Your mining craft is gone. Make another — it is your only income."
          : "You have lost your astronaut. Produce another."
        : "Keep mining — you will be able to replace it shortly.";
    } else {
      // A short heading, and a body that switches from `intro` to `doing` once
      // this drill's opponent is on the board — so the words track what is
      // actually happening rather than narrating a fixed script.
      title = drill.cards.title;
      body = cardBodyFor(drill, activePhase);
    }

    // A recovery is a thing you are saving for too — it just interrupts rather
    // than waiting its turn — so it renders through the same progress line. That
    // answers the question a bare "make another miner" leaves open: how much?
    const tone = cardToneFor(progress);
    // The dead-end PANEL owns this moment — it is the one surface with a Restart
    // button on it, and the run cannot continue without pressing that. Leaving
    // the card up too put two versions of the same sentence in the same patch of
    // sky, overlapping, with the panel on top.
    if (cardMesh) cardMesh.visible = tone !== "deadEnd";
    // ...and no progress line in a dead end. "20 / 35 crystals toward an
    // Astronaut" is true arithmetic and a lie about the situation: there is no
    // path from here to an astronaut. A goal shown to a player who cannot reach
    // it is worse than no goal.
    const savingLine =
      tone === "deadEnd"
        ? ""
        : savingProgressLine(
            progress.recovery
              ? recoveryGoal(progress.recovery)
              : savingTowardFor(progress.drill),
            snapshot.crystals,
          );
    if (
      title !== paintedTitle ||
      body !== paintedBody ||
      savingLine !== paintedProgress ||
      tone !== paintedTone
    ) {
      const moved = title !== paintedTitle || body !== paintedBody;
      paintedTitle = title;
      paintedBody = body;
      paintedProgress = savingLine;
      paintedTone = tone;
      paintCard(
        title,
        body,
        `${progress.drill + 1} / ${TUTORIAL_DRILLS.length}`,
        cardDimmed,
        savingLine,
        tone,
      );
      // New WORDS, new placement — but not for a ticking crystal count, which
      // changes constantly and would drag the card around the room.
      if (moved) this.placeCard();
    }

    // Lock the tablet to the one thing this step is asking for. Recovery wins,
    // so a dead miner is always rebuildable.
    this.setAllowedKind(allowedCreateKind(drill, progress.recovery));
    this.applyArrow(
      drill,
      progress.recovery !== null || progress.deadEnd,
      progress.recovery,
    );
    this.reportArrowProblem(drill);

    if (!state) return;
    const changed =
      before !== progress.drill ||
      (state.getValue(TutorialState, "active") ?? false) !== true ||
      (state.getValue(TutorialState, "deadEnd") ?? false) !== progress.deadEnd;
    state.setValue(TutorialState, "active", true);
    state.setValue(TutorialState, "drill", progress.drill);
    state.setValue(TutorialState, "title", title);
    state.setValue(TutorialState, "body", body);
    state.setValue(TutorialState, "recovery", progress.recovery?.unit ?? "");
    state.setValue(TutorialState, "deadEnd", progress.deadEnd);
    if (changed) bumpRevision(state);
  }

  /** Mutates the shared snapshot in place — no allocation. */
  private fillSnapshot(): void {
    let miners = 0;
    let astronauts = 0;
    let selected = 0;
    for (const unit of this.queries.units.entities) {
      if ((unit.getValue(Health, "current") ?? 0) <= 0) continue;
      const kind = unit.getValue(Unit, "kind");
      if (kind === "miner") miners += 1;
      else if (kind === "astronaut") astronauts += 1;
      if (unit.getValue(Unit, "hasOrder") ?? false) selected += 1;
    }
    let turrets = 0;
    for (const building of this.queries.buildings.entities) {
      if ((building.getValue(Health, "current") ?? 0) <= 0) continue;
      if (building.getValue(Building, "kind") === "turret") turrets += 1;
    }
    let liveEnemies = 0;
    for (const enemy of this.queries.enemies.entities) {
      if (this.isEnemyOnBoard(enemy)) liveEnemies += 1;
    }

    snapshot.minerCount = miners;
    snapshot.astronautCount = astronauts;
    snapshot.turretCount = turrets;
    snapshot.liveEnemyCount = liveEnemies;
    snapshot.selectedUnitCount = boardState.selectedUnits.size;
    snapshot.ordersIssued = selected;
    snapshot.constructionSiteCount =
      this.queries.sites.entities.size + this.queries.craftSites.entities.size;
    snapshot.crystals = boardState.gameState?.getValue(GameState, "crystals") ?? 0;
    snapshot.crystalsMined =
      boardState.gameStats?.getValue(GameStats, "crystalsMined") ?? 0;
    snapshot.enemiesKilled =
      boardState.gameStats?.getValue(GameStats, "enemiesKilled") ?? 0;
    snapshot.matchStatus =
      boardState.waveSource?.getValue(MatchState, "status") ?? "playing";
    snapshot.alertRevision =
      boardState.underAttackAlert?.getValue(UnderAttackAlertState, "revision") ?? 0;
    snapshot.stepElapsedSeconds = drillElapsed;
    snapshot.lookingAtFocus = focusResolved
      ? this.isLookingAt(tmpFocus)
      : true;
    snapshot.gazeProgressSeconds = gazeProgress;
    snapshot.commandCenterAlive =
      boardState.waveSource?.getValue(MatchState, "commandCenterAlive") ?? true;
  }

  /**
   * Choose what the arrow points at, and which tab pulses, for this drill.
   *
   * `interrupted` covers recovery and dead-end cards: the drill's own arrow
   * would still point at its objective while the card is telling the player to
   * rebuild something else, so the pointing layer stands down and lets the
   * words carry it. Sending two different instructions at once is worse than
   * sending one.
   */
  private applyArrow(
    drill: TutorialDrill,
    interrupted: boolean,
    recovery: TutorialRecovery | null = null,
  ): void {
    if (interrupted) {
      // Board arrows go: during a recovery there is nothing out there to point
      // at — the lost unit is precisely what does not exist — and a cone over
      // empty ground during a setback reads as a fault.
      resolvableTargets.length = 0;
      activeArrowTargets = resolvableTargets;
      // The TAB PULSE stays, because for a recovery it is the whole instruction:
      // the thing to do is on the tablet, and the lock has already narrowed it
      // to one card. Suppressing it left the player told what went wrong and not
      // where to fix it.
      this.setTabHint(tabHintFor(drill, snapshot.crystals, recovery));
      return;
    }
    // Keep only the targets that can actually be pointed at. An arrow aimed at
    // nothing is worse than no arrow: the card still has words, but a confident
    // pointer at the wrong place actively misleads.
    resolvableTargets.length = 0;
    for (const candidate of arrowTargetsFor(drill, snapshot, activePhase)) {
      if (canResolveArrow(candidate, snapshot)) resolvableTargets.push(candidate);
    }
    activeArrowTargets = resolvableTargets;
    if (resolvableTargets.some((t) => t.kind === "nearestCrystal")) {
      this.refreshNearestCrystal();
    }
    // The tab pulse is DERIVED from affordability rather than declared as an
    // arrow target, so the astronaut, racer and turret behave identically and
    // the highlight only appears when the click behind it would work.
    this.setTabHint(tabHintFor(drill, snapshot.crystals));
  }

  /** Push a tab hint to the tablet only when it changes — not at 4 Hz. */
  private setTabHint(tab: string | null): void {
    if (tab === activeTabHint) return;
    activeTabHint = tab;
    setTutorialTabHint(tab);
  }

  /** Same discipline for the tablet lock: push only on change. */
  private setAllowedKind(kind: string | null): void {
    if (kind === activeAllowedKind) return;
    activeAllowedKind = kind;
    setTutorialAllowedKind(kind);
  }

  /**
   * Log an unresolvable arrow once per occurrence.
   *
   * Guarded on the message text rather than a boolean so a *different* problem
   * still gets through, while the same one repeating at 4 Hz does not. Cleared
   * when the arrow resolves again, so a recurrence is reported afresh.
   */
  private reportArrowProblem(drill: TutorialDrill): void {
    const problem = arrowProblem(drill, snapshot, activePhase !== "intro");
    if (!problem) {
      reportedArrowProblem = "";
      return;
    }
    if (problem === reportedArrowProblem) return;
    reportedArrowProblem = problem;
    console.warn(`[Tutorial] no arrow: ${problem}`);
  }

  /**
   * Is the command center inside the player's view cone?
   *
   * Drives the orientation beat, which completes on this rather than a timer:
   * from the default XR position the base is behind the player, so a dwell
   * would expire while they were looking at empty terrain and the tutorial
   * would move on having taught nothing.
   *
   * Flattened to the ground plane — looking over or under the base still counts
   * as facing it, which matters on a table-height board where a standing player
   * looks down.
   */
  private isLookingAt(worldPoint: Vector3 | null): boolean {
    // Nothing to find (destroyed, or not yet built): never stall the tutorial.
    if (!worldPoint) return true;

    this.camera.getWorldPosition(tmpCamera);
    tmpCardWorld.copy(worldPoint);
    tmpToCard.copy(tmpCardWorld).sub(tmpCamera);
    tmpToCard.y = 0;
    this.camera.getWorldDirection(tmpForward);
    tmpForward.y = 0;
    if (tmpToCard.lengthSq() < 1e-6 || tmpForward.lengthSq() < 1e-6) return true;
    return tmpForward.normalize().dot(tmpToCard.normalize()) >= TUTORIAL_GAZE_DOT_MIN;
  }

  /**
   * Put the card a comfortable reading distance in front of the viewer and turn
   * it to face them.
   *
   * Called only when the text changes — roughly nine times in a whole tutorial
   * — not every frame. A card welded to the head is hard to read while moving
   * and impossible to look away from; one that is placed where you are looking
   * and then stays put is neither. Same reasoning as the under-attack banner,
   * which samples its position once per raise.
   *
   * Deliberately NOT a fixed board position: see TUTORIAL_CARD_DISTANCE for why
   * no single spot suits both the XR player (board centre) and the desktop
   * preview camera (outside the board).
   */
  private placeCard(): void {
    const mesh = cardMesh;
    const rootObject = boardState.boardRoot?.object3D;
    if (!mesh || !rootObject) return;

    this.camera.getWorldPosition(tmpCamera);
    // Forward, flattened to the ground plane: the card should sit in front of
    // the viewer, never pitched up at the ceiling or down at their feet.
    this.camera.getWorldDirection(tmpForward);
    tmpForward.y = 0;
    if (tmpForward.lengthSq() < 1e-6) tmpForward.set(0, 0, -1);
    tmpForward.normalize();

    tmpAnchor
      .copy(tmpCamera)
      .addScaledVector(tmpForward, TUTORIAL_CARD_DISTANCE);
    // Below eye level, but never below the board. `cameraY - DROP` alone puts
    // the card under the terrain for any head below ~1.36 m, which is what
    // leaning in over a table-height board does — and the body line, being the
    // lower half of the card, is the first thing to disappear.
    rootObject.getWorldPosition(tmpBoardTop);
    tmpAnchor.y = Math.max(
      tmpCamera.y - TUTORIAL_CARD_DROP,
      tmpBoardTop.y + TUTORIAL_CARD_BOARD_CLEARANCE,
    );
    // ...and never over the command center. Same shape as the clamp above — a
    // floor, not a placement — but measured against the BASE rather than the
    // ground, because at the current standing distance the base fills the lower
    // half of the view and the card lives above it.
    //
    // Measured, not assumed: `cameraY - DROP` follows the eye while the base
    // stays put, so a shorter player's card slides down behind it. Reading the
    // real top is what makes this hold for any height.
    //
    // The top of the stack over the base is the LEVEL/TROOPS/GEMS strip, not the
    // building — so this reads the same accessor the `commandCenter` arrow does,
    // and one source of truth means moving the strip moves the card with it.
    // `subjectTopWorldY(commandCenter)` was tried first and measured well below
    // the strip, which left the clamp silently inert.
    const subjectTop = commandCenterHudTopWorldY();
    if (subjectTop !== null) {
      tmpAnchor.y = Math.max(
        tmpAnchor.y,
        subjectTop + TUTORIAL_CARD_SUBJECT_CLEARANCE + TUTORIAL_CARD_HEIGHT / 2,
      );
    }

    this.stepClearOfTablet();

    // The mesh hangs off the board root, so convert into that space.
    rootObject.worldToLocal(tmpAnchor);
    mesh.position.copy(tmpAnchor);
    // Yaw-only turn back toward the viewer.
    mesh.rotation.set(0, Math.atan2(-tmpForward.x, -tmpForward.z), 0);
  }

  /**
   * Slide the card sideways if the tablet is sitting where it wants to go.
   *
   * The tablet rides at the player's right hand and the card is placed dead
   * ahead, so the two share view space whenever the tablet is raised — the
   * Quest capture at t=192s shows the closing card and the Build tab overlaid.
   * Making the card opaque stops the text bleeding through; this stops the
   * overlap. Finding B of `plan/2026-08-20-Quest-Tutorial-Run-Fixes-Plan.md`.
   *
   * Reads and writes `tmpAnchor`, `tmpCamera` and `tmpForward`, which
   * `placeCard` has already filled — it is a step of that method, not a
   * standalone one, and it allocates nothing.
   *
   * **Placement-time only.** It runs when the card is placed or re-placed, not
   * every frame: a card that dodged continuously would jitter as the hand moved,
   * and `keepCardInView` only re-places on real drift. Raising the tablet while
   * the card is already well-placed therefore does not move it — the overlap
   * this fixes is the common case, where the tablet is already up when the next
   * drill begins.
   */
  private stepClearOfTablet(): void {
    const tablet = boardState.tablet?.object3D;
    if (!tablet?.visible) return;
    tablet.getWorldPosition(tmpTablet);
    tmpTablet.sub(tmpCamera);

    // Behind the viewer, or far enough away to be no threat to the card.
    const depth = tmpTablet.dot(tmpForward);
    if (depth <= 0 || depth > TUTORIAL_CARD_TABLET_DEPTH_LIMIT) return;

    // Right-hand axis in the ground plane. forward (0,0,-1) gives (1,0,0).
    tmpRight.set(-tmpForward.z, 0, tmpForward.x);
    const lateral = tmpTablet.dot(tmpRight);
    if (Math.abs(lateral) >= TUTORIAL_CARD_TABLET_CLEARANCE) return;

    // Opposite side of the view from the tablet. A dead-centre tablet pushes
    // the card LEFT, because the tablet is authored for the right hand and its
    // grab handle extends further that way.
    const side = lateral >= 0 ? -1 : 1;
    tmpAnchor.addScaledVector(tmpRight, side * TUTORIAL_CARD_TABLET_CLEARANCE);
  }

  private ensureCard(): boolean {
    // Builds once, then RE-ATTACHES after a detach so a Restart reuses the same
    // canvas, texture and mesh instead of allocating a second card.
    if (!attachTutorialVisualPool(cardPool, this.world)) return false;
    if (cardMesh) return true;
    if (typeof document === "undefined") return false;

    const canvas = document.createElement("canvas");
    canvas.width = TUTORIAL_CARD_TEXTURE_WIDTH;
    canvas.height = TUTORIAL_CARD_TEXTURE_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return false;
    cardContext = context;

    cardTexture = new CanvasTexture(canvas);
    cardTexture.anisotropy = 4;
    cardMaterial = new MeshBasicMaterial({
      map: cardTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    cardMesh = new Mesh(
      new PlaneGeometry(TUTORIAL_CARD_WIDTH, TUTORIAL_CARD_HEIGHT),
      cardMaterial,
    );
    makeNonInteractive(cardMesh);
    // Draw over the scene rather than competing with it. `depthWrite: false`
    // alone still leaves depth TESTING on, so the command center and the
    // terrain both drew over the card — on Quest it was routinely a sliver
    // behind the base. Same helper, same reason, as the under-attack banner.
    liftAboveScene(cardMesh);
    cardMesh.name = "TutorialCard";
    cardMesh.visible = false;
    cardMesh.frustumCulled = false;
    // Its own draw-call category, so the tutorial's cost is visible in the
    // profiler's Draw line rather than hidden in the 100-mesh "static" bucket.
    cardMesh.userData.drawCat = "tutorial";
    // Plain child of the pool, not an entity: TransformSystem re-parents
    // entities every frame and would undo the detach.
    cardPool.group.add(cardMesh);
    // Seed a sane placement so the first frame it becomes visible is already in
    // front of the viewer, rather than at the board origin for a quarter second.
    this.placeCard();
    // A fresh canvas starts blank — force the next evaluate() to paint.
    paintedTitle = "";
    paintedBody = "";
    return true;
  }
}
