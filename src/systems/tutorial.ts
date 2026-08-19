import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  VisibilityState,
  createSystem,
  type Object3D,
} from "@iwsdk/core";
import {
  TUTORIAL_CARD_BACKGROUND,
  TUTORIAL_CARD_BODY_COLOR,
  TUTORIAL_CARD_BORDER,
  TUTORIAL_CARD_HEIGHT,
  TUTORIAL_CARD_STEP_COLOR,
  TUTORIAL_CARD_TEXTURE_HEIGHT,
  TUTORIAL_CARD_TEXTURE_WIDTH,
  TUTORIAL_CARD_TITLE_COLOR,
  TUTORIAL_CARD_DISTANCE,
  TUTORIAL_CARD_DROP,
  TUTORIAL_CARD_FACING_MIN,
  TUTORIAL_CARD_MAX_DISTANCE,
  TUTORIAL_CARD_MIN_DISTANCE,
  TUTORIAL_CARD_WIDTH,
  TUTORIAL_GAZE_DOT_MIN,
  TUTORIAL_ARROW_TABLET_LIFT,
  TUTORIAL_SAMPLE_SECONDS,
  TUTORIAL_THREAT_TILE_STEPS,
} from "./constants.ts";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import { makeNonInteractive } from "./sharedGeometry.js";
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
  TutorialState,
  Unit,
  UnderAttackAlertState,
  WaveSource,
  boardState,
} from "./state.js";
import { TUTORIAL_WAVE_NUMBER } from "./waveCatalog.js";
import { setTutorialTabHint } from "./tablet.js";
import {
  clearTutorialWaveGate,
  setTutorialWaveGate,
  type TutorialSpawnAnchor,
} from "./tutorialWaveGate.js";
import {
  attachTutorialArrowWorld,
  clearTutorialArrow,
  hideTutorialArrow,
  showTutorialArrow,
} from "./tutorialArrow.js";
import {
  TUTORIAL_DRILLS,
  TUTORIAL_ENABLED,
  type ArrowTarget,
  type TutorialDrill,
} from "./tutorialCatalog.ts";
import {
  advanceTutorial,
  arrowProblem,
  arrowTargetFor,
  canResolveArrow,
  interceptTileFor,
  latchDrillStarted,
  nearestCornerTo,
  releaseBudget,
  tutorialHoldsWaveCountdown,
  threatTileFor,
  type TutorialSnapshot,
} from "./tutorialRules.ts";

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
let pooledRoot: Object3D | null = null;

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
/** Last arrow problem reported, so a sustained one logs once, not at 4 Hz. */
let reportedArrowProblem = "";
/**
 * What the arrow is pointing at, chosen by the rules at 4 Hz. The world
 * POSITION is re-resolved every frame from this, so the arrow stays glued to a
 * walking alien rather than lagging it by up to a quarter second.
 */
let activeArrowTarget: ArrowTarget | null = null;
/** The tab currently pulsing, so the hint is only pushed to the tablet on change. */
let activeTabHint: string | null = null;
/**
 * Whether the current drill has visibly begun. A LATCH, not a live read — see
 * latchDrillStarted. Cleared when the drill changes.
 */
let drillStarted = false;
/**
 * Where the first alien lands: the board corner nearest the mine. Resolved once
 * per match from the live board — crystals are hand-placed and never move, so
 * re-deriving it at sample rate would be pure waste.
 */
let spawnAnchor: TutorialSpawnAnchor | null = null;
/** Cached nearest-crystal tile; -1 means none. Refreshed at sample rate. */
let crystalTileX = -1;
let crystalTileY = -1;

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
  lookingAtCommandCenter: false,
  commandCenterAlive: true,
};
const tmpAnchor = new Vector3();
const tmpCamera = new Vector3();
const tmpForward = new Vector3();
const tmpCardWorld = new Vector3();
const tmpToCard = new Vector3();
const tmpArrow = new Vector3();
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
  setTutorialWaveGate({
    governing: isTutorialEnabled(),
    holdsCountdown: tutorialHoldsWaveCountdown(drill, budget),
    releaseBudget: budget,
    spawnAnchor: resolveSpawnAnchor(),
  });
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
export function resetTutorial(): void {
  drillIndex = 0;
  killsAtDrillStart = 0;
  sampleClock = 0;
  drillElapsed = 0;
  paintedTitle = "";
  paintedBody = "";
  reportedArrowProblem = "";
  activeArrowTarget = null;
  drillStarted = false;
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

function paintCard(title: string, body: string, step: string): void {
  const context = cardContext;
  if (!context || !cardTexture) return;
  const width = TUTORIAL_CARD_TEXTURE_WIDTH;
  const height = TUTORIAL_CARD_TEXTURE_HEIGHT;
  context.clearRect(0, 0, width, height);

  context.beginPath();
  context.roundRect(3, 3, width - 6, height - 6, 22);
  context.fillStyle = TUTORIAL_CARD_BACKGROUND;
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = TUTORIAL_CARD_BORDER;
  context.stroke();

  const pad = width * 0.045;
  context.textBaseline = "top";
  context.textAlign = "left";

  context.font = `600 ${Math.round(height * 0.13)}px sans-serif`;
  context.fillStyle = TUTORIAL_CARD_STEP_COLOR;
  context.fillText(step, pad, height * 0.11);

  context.font = `bold ${Math.round(height * 0.2)}px sans-serif`;
  context.fillStyle = TUTORIAL_CARD_TITLE_COLOR;
  context.fillText(title, pad, height * 0.26);

  context.font = `${Math.round(height * 0.15)}px sans-serif`;
  context.fillStyle = TUTORIAL_CARD_BODY_COLOR;
  let y = height * 0.55;
  for (const line of wrapLines(context, body, width - pad * 2)) {
    context.fillText(line, pad, y);
    y += height * 0.19;
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

    // Restart the tutorial when the player actually puts the headset on.
    //
    // Without this it runs during the 2D preview and burns through steps before
    // anyone is in VR: the desktop camera faces the base, so orientation
    // completes in seconds and the player arrives in the headset already on
    // "Mine your first crystals", never having been shown their command center.
    //
    // Only NonImmersive -> Visible resets. VisibleBlurred -> Visible is the
    // headset being taken off and put back on mid-session; restarting the
    // tutorial there would punish someone for adjusting the strap.
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

    let previous = this.world.visibilityState.peek();
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((next) => {
        const entering =
          previous === VisibilityState.NonImmersive &&
          next === VisibilityState.Visible;
        previous = next;
        if (entering) resetTutorial();
      }),
    );
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
      // Dormant, but still holding. A tutorial run waiting in the 2D preview
      // must keep its waves frozen, or the player puts the headset on to find
      // wave 0 already half-spawned and the script skipped.
      this.goDormant(isTutorialEnabled());
      return;
    }
    if (!isTutorialEnabled()) {
      this.goDormant(false);
      return;
    }
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
  }

  /**
   * Point the arrow at whatever the current drill declared, or park it.
   *
   * Resolution is per frame because most targets move. The decision of WHICH
   * target — that is the rules layer's, and it only changes when the drill or
   * its phase does.
   */
  private updateArrow(delta: number): void {
    const target = activeArrowTarget;
    if (!target || !this.resolveArrowTarget(target, tmpArrow)) {
      hideTutorialArrow();
      return;
    }
    showTutorialArrow(tmpArrow, delta);
  }

  /**
   * World position for an arrow target. False means "nothing to point at",
   * which the caller turns into no arrow at all — an arrow aimed at nothing is
   * worse than no arrow, because the card still has words.
   */
  private resolveArrowTarget(target: ArrowTarget, out: Vector3): boolean {
    switch (target.kind) {
      case "commandCenter":
        return this.worldOfEntity(boardState.commandCenter, out);
      case "nearestUnit":
        return this.worldOfNearestUnit(target.unit, out);
      case "nearestCrystal":
        return this.worldOfNearestCrystal(out);
      case "nearestEnemy":
        return this.worldOfNearestEnemy(out);
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
    }
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

  /** Nearest live enemy to the base — the one that matters, not the closest one. */
  private worldOfNearestEnemy(out: Vector3): boolean {
    if (!this.worldOfEntity(boardState.commandCenter, tmpFrom)) {
      this.camera.getWorldPosition(tmpFrom);
    }
    let best = Number.POSITIVE_INFINITY;
    let found = false;
    for (const enemy of this.queries.enemies.entities) {
      if ((enemy.getValue(Health, "current") ?? 0) <= 0) continue;
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
    if (tmpForward.dot(tmpToCard) < TUTORIAL_CARD_FACING_MIN) this.placeCard();
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
    activeArrowTarget = null;
    hideTutorialArrow();
    this.setTabHint(null);
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
      // A new drill starts its own dwell clock, and its own started latch.
      drillElapsed = 0;
      drillStarted = false;
    }

    // Before anything visual: the wave system reads this, and it must reflect
    // the drill we just advanced to rather than the previous one.
    publishTutorialWaveGate(progress.drill, progress.releaseOpponent);

    const state = boardState.tutorial;
    const active = progress.drill >= 0;
    if (cardMesh) cardMesh.visible = active;

    if (!active) {
      activeArrowTarget = null;
      this.setTabHint(null);
      if (state && (state.getValue(TutorialState, "active") ?? false)) {
        state.setValue(TutorialState, "active", false);
        state.setValue(TutorialState, "drill", -1);
        bumpRevision(state);
      }
      return;
    }

    const drill = TUTORIAL_DRILLS[progress.drill];
    drillStarted = latchDrillStarted(drill, snapshot, drillStarted);
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
      body = drillStarted ? drill.cards.doing : drill.cards.intro;
    }

    if (title !== paintedTitle || body !== paintedBody) {
      paintedTitle = title;
      paintedBody = body;
      paintCard(title, body, `${progress.drill + 1} / ${TUTORIAL_DRILLS.length}`);
      // New words, new placement: put the card wherever the player is looking
      // now. Between changes it stays exactly where it was.
      this.placeCard();
    }

    this.applyArrow(drill, progress.recovery !== null || progress.deadEnd);
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
      if ((enemy.getValue(Health, "current") ?? 0) > 0) liveEnemies += 1;
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
    snapshot.lookingAtCommandCenter = this.isLookingAtCommandCenter();
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
  private applyArrow(drill: TutorialDrill, interrupted: boolean): void {
    if (interrupted) {
      activeArrowTarget = null;
      this.setTabHint(null);
      return;
    }
    const target = arrowTargetFor(drill, snapshot, drillStarted);
    activeArrowTarget = canResolveArrow(target, snapshot) ? target : null;
    if (activeArrowTarget?.kind === "nearestCrystal") {
      this.refreshNearestCrystal();
    }
    this.setTabHint(
      activeArrowTarget?.kind === "tabletTab" ? activeArrowTarget.tab : null,
    );
  }

  /** Push a tab hint to the tablet only when it changes — not at 4 Hz. */
  private setTabHint(tab: string | null): void {
    if (tab === activeTabHint) return;
    activeTabHint = tab;
    setTutorialTabHint(tab);
  }

  /**
   * Log an unresolvable arrow once per occurrence.
   *
   * Guarded on the message text rather than a boolean so a *different* problem
   * still gets through, while the same one repeating at 4 Hz does not. Cleared
   * when the arrow resolves again, so a recurrence is reported afresh.
   */
  private reportArrowProblem(drill: TutorialDrill): void {
    const problem = arrowProblem(drill, snapshot, drillStarted);
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
  private isLookingAtCommandCenter(): boolean {
    const holder = boardState.commandCenter?.object3D ?? null;
    // No base to find (destroyed, or not yet built): never stall the tutorial.
    if (!holder) return true;

    this.camera.getWorldPosition(tmpCamera);
    holder.getWorldPosition(tmpCardWorld);
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
    tmpAnchor.y = tmpCamera.y - TUTORIAL_CARD_DROP;

    // The mesh hangs off the board root, so convert into that space.
    rootObject.worldToLocal(tmpAnchor);
    mesh.position.copy(tmpAnchor);
    // Yaw-only turn back toward the viewer.
    mesh.rotation.set(0, Math.atan2(-tmpForward.x, -tmpForward.z), 0);
  }

  private ensureCard(): boolean {
    const root = boardState.boardRoot;
    const rootObject = root?.object3D ?? null;
    if (!root || !rootObject) return false;
    if (pooledRoot === rootObject && cardMesh) return true;
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
    cardMesh.name = "TutorialCard";
    cardMesh.visible = false;
    cardMesh.frustumCulled = false;
    // Its own draw-call category, so the tutorial's cost is visible in the
    // profiler's Draw line rather than hidden in the 100-mesh "static" bucket.
    cardMesh.userData.drawCat = "tutorial";
    this.world.createTransformEntity(cardMesh, { parent: root });
    pooledRoot = rootObject;
    // Seed a sane placement so the first frame it becomes visible is already in
    // front of the viewer, rather than at the board origin for a quarter second.
    this.placeCard();
    // A fresh canvas starts blank — force the next evaluate() to paint.
    paintedTitle = "";
    paintedBody = "";
    return true;
  }
}
