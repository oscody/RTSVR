import {
  BoxGeometry,
  Entity,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OneHandGrabbable,
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
  UIKitDocument,
  Vector3,
  VisibilityState,
  createSystem,
} from "@iwsdk/core";
import { BUILDING_CATALOG, getBuildingSpec } from "./buildingCatalog.js";
import {
  ASTRONAUT_PRODUCTION_SPEC,
  CRAFT_CATALOG,
  getCraftSpec,
  getProductionSpec,
} from "./craftCatalog.js";
import { validateCraftPurchase } from "./craftRules.js";
import { validateBuildOrder } from "./constructionRules.js";
import {
  currentBuildingMaxHealth,
  currentEnemyMaxHealth,
  currentUnitMaxHealth,
} from "./debugStatOverrides.js";
import { DEBUG_SETTINGS_CATALOG } from "./debugSettingsCatalog.js";
import { updateHealthBar } from "./healthBar.js";
import {
  TABLET_CARD_BORDER,
  BOARD_Y,
  PLAYER_SPAWN,
  DESKTOP_CAMERA,
  DESKTOP_CAMERA_TARGET,
  TABLET_ASSUMED_EYE_HEIGHT,
  TABLET_DESKTOP_POSITION,
  TABLET_EYE_DROP,
  TABLET_PLAYER_X_OFFSET,
  TABLET_PLAYER_Z_OFFSET,
  TABLET_EMPTY_UNIT_BACKGROUND,
  TABLET_EMPTY_UNIT_BORDER,
  TABLET_FRAME_COLOR,
  TABLET_FRAME_METALNESS,
  TABLET_FRAME_ROUGHNESS,
  TABLET_FRAME_SIZE,
  TABLET_FRAME_Z_OFFSET,
  TABLET_HANDLE_COLOR,
  TABLET_HANDLE_METALNESS,
  TABLET_HANDLE_ROUGHNESS,
  TABLET_HANDLE_SIZE,
  TABLET_HANDLE_X_OFFSET,
  TABLET_LOCKED_UNIT_BACKGROUND,
  TABLET_LOCKED_UNIT_BORDER,
  TABLET_PANEL_MAX_HEIGHT,
  TABLET_PANEL_MAX_WIDTH,
  TABLET_SCREEN_Z_OFFSET,
  TABLET_SELECTED_BUILD_BORDER,
  TABLET_SELECTED_CRAFT_BORDER,
  TABLET_SELECTED_UNIT_BACKGROUND,
  TABLET_STATUS_ERROR_COLOR,
  TABLET_STATUS_INFO_COLOR,
  TABLET_STATUS_SUCCESS_COLOR,
  TABLET_TAB_ACTIVE_BACKGROUND,
  TABLET_TAB_ACTIVE_BORDER,
  TABLET_TAB_INACTIVE_BACKGROUND,
  TABLET_TAB_INACTIVE_BORDER,
  TABLET_TUTORIAL_LOCKED_OPACITY,
  TABLET_UNIT_BACKGROUND,
  TABLET_Y_OFFSET,
  TUTORIAL_TAB_PULSE_BACKGROUND,
  TUTORIAL_TAB_PULSE_BORDER,
  TUTORIAL_TAB_PULSE_SECONDS,
} from "./constants.ts";
import { tabPulseOn } from "./tutorialRules.ts";
import { tutorialHoldsCountdown } from "./tutorialWaveGate.js";
import { TUTORIAL_WAVE_NUMBER } from "./waveCatalog.js";
import {
  clearUnitSelections,
  getSelectedUnits,
  getSingleSelectedUnit,
  refreshTurretRangeRingGeometry,
  refreshUnitAttackRangeRingGeometry,
  toggleTurretRangeRing,
  toggleUnitSelection,
  updateCommandGridVisibility,
} from "./selection.js";
import {
  countRosterKinds,
  paginateRoster,
  type RosterEntry,
} from "./selectionRules.js";
import { currentBuildTarget } from "./construction.js";
import { canDestroy, destroyOwnEntity } from "./demolition.js";
import { destroyRefund } from "./constructionRules.js";
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
  SelectionState,
  TabletState,
  TutorialState,
  Unit,
  UnitSelection,
  WaveSource,
  WaveUnit,
  boardState,
  type DebugSettingKey,
} from "./state.js";
import { observeMiningEconomyRead } from "./phase2Trace.js";
import { traceRead } from "./trace.js";
import { State } from "./traceIds.js";


/**
 * Which tab the tutorial is currently pointing at, or null.
 *
 * A module-level flag rather than a component: it is read once per frame by the
 * one system that owns the tablet, and nothing else ever needs to see it. The
 * dependency runs tutorial -> tablet only; the tablet never imports the
 * tutorial system, so there is no cycle.
 */
let tutorialTabHint: string | null = null;

/** Set from TutorialSystem. Pass null to hand the tab back to normal styling. */
export function setTutorialTabHint(tab: string | null): void {
  tutorialTabHint = tab;
}

/**
 * The one thing the tutorial will let the player build or produce, or null for
 * no lock.
 *
 * Everything else greys out and refuses its click, so "make an astronaut" cannot
 * be answered by making something else. **Tablet only** — units on the board stay
 * selectable, so the miner can always be re-tasked and a drill can never strand a
 * player whose crystal patch runs dry.
 */
let tutorialAllowedKind: string | null = null;

export function setTutorialAllowedKind(kind: string | null): void {
  if (tutorialAllowedKind === kind) return;
  tutorialAllowedKind = kind;
  // The tablet only repaints when something it watches changes, and the lock is
  // module state rather than a component — without this bump the greying would
  // not appear until the player happened to change something else.
  tutorialLockRevision += 1;
}

/** Bumped whenever the lock changes, so the repaint guard can see it. */
let tutorialLockRevision = 0;

/** The tablet's frame, so the pose can be re-applied on a session change. */
let tabletShell: Group | null = null;
const tmpAimTarget = new Vector3();
const tmpAimEye = new Vector3();
const tmpAim = new Matrix4();

/** Is this build/craft kind currently offerable? */
function tutorialAllows(kind: string): boolean {
  return tutorialAllowedKind === null || tutorialAllowedKind === kind;
}

/**
 * What to call the locked-to kind in a refusal.
 *
 * The raw kind would read "build a astronaut" — and worse, it is the internal
 * name, which is not always what the card says.
 */
function tutorialWants(): string {
  const kind = tutorialAllowedKind;
  if (!kind) return "";
  return getProductionSpec(kind)?.label ?? getBuildingSpec(kind)?.label ?? kind;
}

type UiElement = UIKit.Text & {
  setProperties(properties: Record<string, unknown>): void;
};

function element(document: UIKitDocument, id: string): UiElement | null {
  return document.getElementById(id) as UiElement | null;
}

interface LiveRosterEntry extends RosterEntry {
  entity: Entity;
  // Turrets ride in the same roster but are Buildings — they toggle a range
  // ring instead of joining the unit selection.
  building: boolean;
}

export class TabletSystem extends createSystem({
  tablets: { required: [TabletState, PanelUI, PanelDocument] },
  buildings: { required: [Building, Health] },
  units: { required: [Unit, UnitSelection, Health] },
  enemies: { required: [Enemy, Health] },
}) {
  private document: UIKitDocument | null = null;
  private tabletEntity: Entity | null = null;
  // Last value written to each element, so unchanged writes can be skipped.
  // WeakMap keyed on the element: entries vanish with a rebuilt document, so a
  // stale guard can never suppress a real update.
  private readonly lastSetText = new WeakMap<object, string>();
  private readonly lastSetProps = new WeakMap<object, string>();
  private lastAstronauts = Number.NaN;
  private lastBuildingCount = Number.NaN;
  private lastCountdown = Number.NaN;
  private lastCrafts = Number.NaN;
  private lastCrystals = Number.NaN;
  /** Last GameState revision observed by this (earlier-than-Mining) reader. */
  private lastEconomyRevision = Number.NaN;
  private lastDebugRevision = Number.NaN;
  private lastEnemyCount = Number.NaN;
  private lastKills = Number.NaN;
  private lastMined = Number.NaN;
  private lastSelectionRevision = Number.NaN;
  private lastTabletRevision = Number.NaN;
  private lastWaveNumber = Number.NaN;
  private lastWaveStage = "";
  /** Tri-state so the first frame always writes. See the wave-banner block. */
  private lastShowWaveBanner: boolean | null = null;
  /** `"<tab>:<lit>"` of the last tutorial pulse write; "" when nothing is lit. */
  private lastTabHintKey = "";
  private tabHintClock = 0;
  /** Tutorial tablet-lock revision last painted. */
  private lastLockRevision = -1;
  /** TutorialState.revision last mirrored into the status line. */
  private lastTutorialRevision = Number.NaN;

  init(): void {
    this.createTablet();
    // The tablet needs two poses, not one. Authored for a player's right hand,
    // it is edge-on and over the command center when the browser camera looks at
    // the board from outside — so the preview gets its own placement, swapped on
    // the session boundary rather than tested every frame.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.applyTabletPose(state !== VisibilityState.NonImmersive);
      }),
    );
    this.cleanupFuncs.push(
      this.queries.tablets.subscribe("qualify", (entity) => {
        this.tabletEntity = entity;
        this.document = PanelDocument.data.document[entity.index] as UIKitDocument;
        this.bind(this.document, entity);
        this.invalidateSnapshot();
      }),
    );
  }

  update(delta: number): void {
    const tablet = this.tabletEntity;
    const document = this.document;
    if (!tablet || !document) return;

    const waveSource = boardState.waveSource;
    const waveStage = waveSource?.getValue(WaveSource, "stage") ?? "countdown";
    const waveNumber = waveSource?.getValue(WaveSource, "waveNumber") ?? 1;
    const countingDown = waveStage === "countdown";
    if (waveNumber !== this.lastWaveNumber) {
      this.lastWaveNumber = waveNumber;
      // The markup renders "Level " + this, so wave 0 reads
      // "Level 0 - TUTORIAL LEVEL". The HUD strip already said LEVEL TUTORIAL
      // and the tablet still said "Level 0", which reads as a bug and undercut
      // the reason the special case exists.
      //
      // The chip is sized for one or two digits, so it has to grow with the
      // text and the value has to drop to label size — otherwise the words
      // overflow the chip, wrap, and collide with the Restart/Exit row.
      const tutorialLevel = waveNumber === TUTORIAL_WAVE_NUMBER;
      this.setText(
        "current-level",
        tutorialLevel ? `${waveNumber} - TUTORIAL LEVEL` : `${waveNumber}`,
      );
      this.setProps("level-chip", `${tutorialLevel}`, {
        width: tutorialLevel ? 208 : 86,
      });
      this.setProps("current-level", `${tutorialLevel}`, {
        fontSize: tutorialLevel ? 13 : 20,
      });
      this.setText("wave-banner-label", `Wave ${waveNumber} incoming in`);
    }
    // Hide the incoming-wave banner while the tutorial is holding the
    // countdown. The timer is parked at the activation lead, so the banner sat
    // on "Wave 0 incoming in 2" for the whole of Act 1 — a countdown that never
    // reaches zero, promising something that is not coming until the player
    // mines. It returns by itself the moment the tutorial releases the hold,
    // and is untouched when the tutorial is off.
    const showWaveBanner = countingDown && !tutorialHoldsCountdown();
    if (showWaveBanner !== this.lastShowWaveBanner) {
      this.lastShowWaveBanner = showWaveBanner;
      this.lastWaveStage = waveStage;
      element(document, "wave-banner")?.setProperties({
        display: showWaveBanner ? "flex" : "none",
      });
    }
    if (countingDown) {
      const waveTimer = waveSource?.getValue(WaveSource, "timer") ?? 0;
      const countdown = Math.max(0, Math.ceil(waveTimer));
      if (countdown !== this.lastCountdown) {
        this.lastCountdown = countdown;
        this.setText("wave-countdown", `${countdown}`);
      }
    }

    const game = boardState.gameState;
    const stats = boardState.gameStats;
    const crystals = game?.getValue(GameState, "crystals") ?? 0;
    const economyRevision = game?.getValue(GameState, "revision") ?? 0;
    if (economyRevision !== this.lastEconomyRevision) {
      this.lastEconomyRevision = economyRevision;
      traceRead(State.Crystals, crystals, economyRevision);
      observeMiningEconomyRead(economyRevision);
    }
    const mined = stats?.getValue(GameStats, "crystalsMined") ?? 0;
    let astronauts = 0;
    let crafts = 0;
    for (const unit of this.queries.units.entities) {
      if (unit.getValue(Unit, "kind") === "astronaut") astronauts += 1;
      else crafts += 1;
    }
    const tabletRevision = tablet.getValue(TabletState, "revision") ?? 0;
    const buildingCount = this.queries.buildings.entities.size;
    // "Enemies alive" is a claim about the BOARD, so it counts only what is on
    // it: alive, and released. A wave's reserve is built during the countdown
    // and sits detached and invisible until released, so counting it said
    // "3 enemies alive" next to "0 killed" while the board was empty.
    //
    // Pre-existing — a normal wave's countdown has the same reserve — but the
    // tutorial made the window minutes long instead of seconds, which is what
    // exposed it. The query itself is NOT narrowed: the debug health-rescale
    // below must still reach reserves, or a released alien would arrive with
    // stale health.
    let enemyCount = 0;
    for (const enemy of this.queries.enemies.entities) {
      if ((enemy.getValue(Health, "current") ?? 0) <= 0) continue;
      if (
        enemy.hasComponent(WaveUnit) &&
        enemy.getValue(WaveUnit, "stage") === "waiting"
      ) {
        continue;
      }
      enemyCount += 1;
    }
    const kills = stats?.getValue(GameStats, "enemiesKilled") ?? 0;
    const selectionRevision =
      boardState.selection?.getValue(SelectionState, "revision") ?? 0;
    const debugRevision =
      boardState.debugSettings?.getValue(DebugSettings, "revision") ?? 0;
    const lockRevision = tutorialLockRevision;
    // Before the dirty guard below: the pulse changes with time and nothing
    // else, so anything downstream of that early-out would never animate.
    this.applyTabHint(delta, tablet.getValue(TabletState, "view") ?? "overview");
    this.applyTutorialStatus(tablet);
    if (
      tabletRevision === this.lastTabletRevision &&
      crystals === this.lastCrystals &&
      mined === this.lastMined &&
      buildingCount === this.lastBuildingCount &&
      astronauts === this.lastAstronauts &&
      crafts === this.lastCrafts &&
      enemyCount === this.lastEnemyCount &&
      kills === this.lastKills &&
      selectionRevision === this.lastSelectionRevision &&
      debugRevision === this.lastDebugRevision &&
      lockRevision === this.lastLockRevision
    ) {
      return;
    }
    this.lastLockRevision = lockRevision;
    this.lastTabletRevision = tabletRevision;
    this.lastCrystals = crystals;
    this.lastMined = mined;
    this.lastBuildingCount = buildingCount;
    this.lastAstronauts = astronauts;
    this.lastCrafts = crafts;
    this.lastEnemyCount = enemyCount;
    this.lastKills = kills;
    this.lastSelectionRevision = selectionRevision;
    this.lastDebugRevision = debugRevision;

    this.setText("crystal-balance", `${crystals}`);
    this.setText("overview-crystals", `${crystals}`);
    this.setText("overview-mined", `${mined}`);
    this.setText("overview-buildings", `${buildingCount}`);
    this.setText("overview-crafts", `${crafts}`);
    this.setText("overview-units", `${crafts + astronauts}`);
    this.setText("overview-astronauts", `${astronauts}`);
    this.setText("overview-enemies", `${enemyCount}`);
    this.setText("overview-kills", `${kills}`);
    this.setText("tablet-status", tablet.getValue(TabletState, "status") ?? "");
    this.setProps("tablet-status", tablet.getValue(TabletState, "statusKind") ?? "", {
      color:
        tablet.getValue(TabletState, "statusKind") === "error"
          ? TABLET_STATUS_ERROR_COLOR
          : tablet.getValue(TabletState, "statusKind") === "success"
            ? TABLET_STATUS_SUCCESS_COLOR
            : TABLET_STATUS_INFO_COLOR,
    });
    const astronautIndex = tablet.getValue(TabletState, "astronautIndex") ?? -1;
    this.setText(
      "builder-label",
      astronautIndex >= 0
        ? `Astronaut #${astronautIndex}`
        : "Place a building - an astronaut will come",
    );
    const view = tablet.getValue(TabletState, "view") ?? "overview";
    // Tabs and view visibility are always applied: they are what makes the
    // switch happen, and they touch 10 elements, not 119.
    this.applyView(view);

    // ── Only touch the visible tab ──────────────────────────────────────────
    //
    // Everything below used to run on every repaint for all five views at once.
    // The per-element write guards stopped the redundant `setProperties` calls,
    // but the element lookup, the string building and the traversal still
    // happened for ~245 elements to update the ~30 the player could see.
    //
    // `settings-view` alone is **119 of the tablet's 275 elements — 43%** — and
    // it is the playtesting knobs, which are never open during play. It was
    // being walked and rewritten every repaint from behind a `display: none`.
    //
    // Measured precedent: deleting the 17-span profiler strip (~6% of the
    // document) took the p90 worst frame from 36.8 ms to 26.0 ms. This skips far
    // more than that, though it skips *work on* elements rather than removing
    // them — which is the distinction the next step has to settle.
    if (view === "build") {
      this.applySiteActions(tablet);
      this.applySelectedCard(
        tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
      );
      const astronautIndex = tablet.getValue(TabletState, "astronautIndex") ?? -1;
      this.setText(
        "builder-label",
        astronautIndex >= 0
          ? `Astronaut #${astronautIndex}`
          : "Place a building - an astronaut will come",
      );
      const selectedBuildingKind =
        tablet.getValue(TabletState, "selectedBuildingKind") ?? "none";
      const building = getBuildingSpec(selectedBuildingKind);
      const buildUnit = getProductionSpec(
        tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
      );
      const buildingUnitSelected =
        buildUnit?.kind === ASTRONAUT_PRODUCTION_SPEC.kind &&
        selectedBuildingKind === "none";
      const placingBuildUnit =
        tablet.getValue(TabletState, "craftPlacementActive") ?? false;
      const placingBuilding =
        tablet.getValue(TabletState, "buildPlacementActive") ?? false;
      this.setText(
        "build-action-label",
        buildingUnitSelected && buildUnit
          ? placingBuildUnit
            ? `Choose tile for ${buildUnit.label}`
            : `Produce ${buildUnit.label} - ${buildUnit.cost}`
          : building
            ? placingBuilding
              ? `Choose tile for ${building.label}`
              : `Produce ${building.label} - ${building.cost}`
            : "Choose a building",
      );
    } else if (view === "crafts") {
      const craftKind =
        tablet.getValue(TabletState, "selectedCraftKind") ?? "none";
      const craft = getCraftSpec(craftKind);
      const placingCraft =
        tablet.getValue(TabletState, "craftPlacementActive") ?? false;
      // The header says what the tab does; no production building is required.
      this.setText("craft-source-label", "Pick a craft, then pick a tile");
      this.setText(
        "craft-action-label",
        craft
          ? placingCraft
            ? `Choose tile for ${craft.label}`
            : `Produce ${craft.label} - ${craft.cost}`
          : "Choose a craft",
      );
      this.applyCraftPage(tablet, craftKind);
    } else if (view === "units") {
      this.applyUnitPage(tablet);
    } else if (view === "settings") {
      this.applySettingsView();
    }
  }

  // Keeps the three destructive actions honest about what they would do right
  // now: what gets cancelled, how many units get scrapped and for how much, and
  // that the command center refuses. All three route through the same dirty
  // guard, so an unchanged label costs nothing.
  private applySiteActions(tablet: Entity): void {
    const clicked = tablet.getValue(TabletState, "selectedSite") as Entity | null;
    const site =
      clicked && this.isLiveSite(clicked) ? clicked : currentBuildTarget();
    let cancelLabel = "No build to cancel";
    if (site?.hasComponent(ConstructionSite)) {
      const label =
        getBuildingSpec(site.getValue(ConstructionSite, "kind") ?? "")?.label ??
        "Site";
      cancelLabel = `Cancel ${label} +${site.getValue(ConstructionSite, "cost") ?? 0}`;
    } else if (site?.hasComponent(CraftProductionSite)) {
      const spec = getProductionSpec(
        site.getValue(CraftProductionSite, "kind") ?? "",
      );
      cancelLabel = `Cancel ${spec?.label ?? "Craft"} +${spec?.cost ?? 0}`;
    }
    this.setText("build-cancel-label", cancelLabel);
    // The Crafts tab's cancel is narrower, so it drops the refund figure rather
    // than overflowing its row; the status line still reports the exact amount.
    this.setText(
      "craft-cancel-label",
      cancelLabel === "No build to cancel"
        ? "Nothing to cancel"
        : cancelLabel.replace(/ \+\d+$/, ""),
    );

    const units = getSelectedUnits();
    let unitRefund = 0;
    for (const unit of units) {
      unitRefund += destroyRefund(
        getProductionSpec(unit.getValue(Unit, "kind") ?? "")?.cost ?? 0,
      );
    }
    // With no units selected the button falls through to the focused turret,
    // so the label has to say so rather than a bare "Destroy".
    const focused = tablet.getValue(TabletState, "focusBuilding") as
      | Entity
      | null;
    const focusedKind = focused?.hasComponent(Building)
      ? (focused.getValue(Building, "kind") ?? null)
      : null;
    this.setText(
      "unit-destroy-label",
      units.length > 0
        ? `Destroy ${units.length} +${unitRefund}`
        : focusedKind === "command-center"
          ? "Cannot destroy HQ"
          : focusedKind
            ? `Destroy ${this.buildingLabel(focusedKind)} +${destroyRefund(
                getBuildingSpec(focusedKind)?.cost ?? 0,
              )}`
            : "Destroy",
    );
  }

  private invalidateSnapshot(): void {
    this.lastAstronauts = Number.NaN;
    this.lastBuildingCount = Number.NaN;
    this.lastCountdown = Number.NaN;
    this.lastCrafts = Number.NaN;
    this.lastCrystals = Number.NaN;
    this.lastDebugRevision = Number.NaN;
    this.lastEnemyCount = Number.NaN;
    this.lastKills = Number.NaN;
    this.lastMined = Number.NaN;
    this.lastSelectionRevision = Number.NaN;
    this.lastTabletRevision = Number.NaN;
    this.lastWaveNumber = Number.NaN;
    this.lastWaveStage = "";
  }

  private createTablet(): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("TabletSystem requires BoardSystem first");
    const frame = new Group();
    frame.name = "RTSVRTablet";
    const backing = new Mesh(
      new BoxGeometry(...TABLET_FRAME_SIZE),
      new MeshStandardMaterial({
        color: TABLET_FRAME_COLOR,
        roughness: TABLET_FRAME_ROUGHNESS,
        metalness: TABLET_FRAME_METALNESS,
      }),
    );
    backing.name = "RTSVRTabletFrame";
    backing.position.z = TABLET_FRAME_Z_OFFSET;
    // The backing covers the whole panel. Keep it visual-only so it cannot
    // intercept pointer rays before UIKit's buttons receive them.
    backing.raycast = () => {};
    frame.add(backing);
    const handle = new Mesh(
      new BoxGeometry(...TABLET_HANDLE_SIZE),
      new MeshStandardMaterial({
        color: TABLET_HANDLE_COLOR,
        roughness: TABLET_HANDLE_ROUGHNESS,
        metalness: TABLET_HANDLE_METALNESS,
      }),
    );
    handle.name = "RTSVRTabletGrabHandle";
    handle.position.set(TABLET_HANDLE_X_OFFSET, 0, 0);
    frame.add(handle);

    const shell = this.world
      .createTransformEntity(frame, { parent: root })
      .addComponent(OneHandGrabbable, { rotate: true, translate: true });
    shell.object3D!.name = "RTSVRTabletShell";

    const tablet = this.world
      .createTransformEntity(undefined, { parent: shell })
      .addComponent(PanelUI, {
        config: "./ui/rts-tablet.json",
        maxWidth: TABLET_PANEL_MAX_WIDTH,
        maxHeight: TABLET_PANEL_MAX_HEIGHT,
      })
      .addComponent(RayInteractable)
      .addComponent(TabletState);
    if (boardState.commandCenter) {
      tablet.setValue(TabletState, "spawnBuilding", boardState.commandCenter);
      tablet.setValue(
        TabletState,
        "spawnBuildingIndex",
        boardState.commandCenter.index,
      );
    }
    tablet.object3D!.name = "RTSVRTabletScreen";
    tablet.object3D!.position.z = TABLET_SCREEN_Z_OFFSET;
    tabletShell = shell.object3D as Group;
    // Startup is always non-immersive, so this lands on the preview pose first
    // and the subscription below swaps it the moment a session begins.
    this.applyTabletPose(
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive,
    );
    boardState.tablet = tablet;
  }

  /**
   * Put the tablet in its VR pose or its 2D-preview pose.
   *
   * **The VR pose always wins on entering a session**, even if the player had
   * grabbed the tablet and moved it — it is `OneHandGrabbable` with `rotate` and
   * `translate`, so it can be anywhere. Deliberate: a panel left floating over
   * the far rim is one you would have to walk around the board to fetch, and
   * predictable beats sticky for the thing you read your resources off.
   *
   * The preview facing is COMPUTED, not authored. `lookAt` on a non-camera
   * object points its **+Z** at the target — the panel's readable face — and it
   * resolves the parent transform itself, which matters because the shell hangs
   * off `BoardRoot`. Deriving it means the tablet keeps facing the camera if
   * `DESKTOP_CAMERA` is ever retuned, with nothing to keep in sync by hand.
   */
  private applyTabletPose(immersive: boolean): void {
    const shell = tabletShell;
    if (!shell) return;
    const root = boardState.boardRoot?.object3D;
    if (!root) return;
    if (immersive) {
      shell.position.set(
        PLAYER_SPAWN[0] + TABLET_PLAYER_X_OFFSET,
        PLAYER_SPAWN[1] + TABLET_ASSUMED_EYE_HEIGHT - TABLET_EYE_DROP - BOARD_Y,
        PLAYER_SPAWN[2] + TABLET_PLAYER_Z_OFFSET,
      );
      // Aimed at the player's head, not set from a constant.
      //
      // `TABLET_ROTATION` was an authored tilt that had never been pointed at
      // anybody: it left the panel **95.7 degrees** off the direction to the
      // viewer — very nearly edge-on, which is the one orientation a flat panel
      // cannot be read from. It survived because the number looked innocuous
      // and nothing measured it.
      //
      // Derived from `PLAYER_SPAWN`, so it stays correct through any further
      // move of the standing position — the same reason the tablet's *position*
      // is anchored there.
      this.aimShellAt(
        shell,
        root,
        tmpAimTarget.set(
          PLAYER_SPAWN[0],
          PLAYER_SPAWN[1] + TABLET_ASSUMED_EYE_HEIGHT,
          PLAYER_SPAWN[2],
        ),
      );
      return;
    }
    shell.position.set(...TABLET_DESKTOP_POSITION);
    // Parallel to the camera's IMAGE PLANE — not aimed at the camera's position.
    //
    // These are different orientations and only one of them looks straight. A
    // plane parallel to the image plane projects to a scaled rectangle: no
    // shear, edges square to the screen. A plane whose normal points AT an
    // off-axis camera is "facing" it in the geometric sense and still renders
    // visibly slanted, because its up vector does not project to vertical.
    // Here the two differ by 22 degrees of normal and 17.9 of up, which is
    // exactly the tilt that reads as wrong.
    //
    // Aiming at the point is right in VR, where the viewer moves their head and
    // there is no fixed frame to be square to. In a browser window there is.
    root.updateMatrixWorld(true);
    root.worldToLocal(tmpAimTarget.set(...DESKTOP_CAMERA));
    root.worldToLocal(tmpAimEye.set(...DESKTOP_CAMERA_TARGET));
    // `Matrix4.lookAt(eye, target, up)` builds +Z = normalize(eye - target) and
    // +Y = up-made-perpendicular. Passing the CAMERA as eye and ITS target as
    // target therefore reproduces the camera's own basis — which is precisely
    // "parallel to the image plane". The panel's own position is irrelevant to
    // that, and is deliberately not used.
    tmpAim.lookAt(tmpAimTarget, tmpAimEye, shell.up);
    shell.quaternion.setFromRotationMatrix(tmpAim);
  }

  /**
   * Turn the tablet's readable face toward a world-space point.
   *
   * **Aims in the PARENT's frame, not in world space.** `Object3D.lookAt` reads
   * the object's own `matrixWorld`, which is not current right after writing
   * `position` — IWSDK's transform sync has not run. It therefore treats the
   * board-LOCAL position as a world one, 0.78 m too low, and over-pitches by
   * 9.3 degrees. That looked plausible, which is the dangerous kind of wrong.
   *
   * BoardRoot carries no rotation and no scale, so converting the target into
   * board space and aiming there is exactly equivalent — and depends on no
   * matrix being up to date. Mirrors three's own `lookAt`, which puts **+Z**
   * through the target for non-camera objects; +Z is the readable face.
   */
  private aimShellAt(shell: Group, root: Object3D, worldTarget: Vector3): void {
    root.updateMatrixWorld(true);
    root.worldToLocal(worldTarget);
    tmpAim.lookAt(worldTarget, shell.position, shell.up);
    shell.quaternion.setFromRotationMatrix(tmpAim);
  }

  private bind(document: UIKitDocument, tablet: Entity): void {
    const on = (id: string, handler: () => void) => {
      document.getElementById(id)?.addEventListener("click", handler);
    };
    on("tab-overview", () => this.setView(tablet, "overview", "Economy overview"));
    on("tab-build", () => this.setView(tablet, "build", "Choose a building"));
    on("tab-crafts", () => this.openCrafts(tablet));
    on("tab-units", () => this.openUnits(tablet));
    on("tab-settings", () => this.setView(tablet, "settings", "Playtesting settings"));
    on("exit-vr", () => {
      this.world.exitXR();
    });
    on("restart-game", () => {
      const source = boardState.waveSource;
      if (!source) return;
      source.setValue(MatchState, "status", "restarting");
    });

    for (const spec of DEBUG_SETTINGS_CATALOG) {
      on(`setting-${spec.key}-minus`, () => this.adjustSetting(tablet, spec.key, -1));
      on(`setting-${spec.key}-plus`, () => this.adjustSetting(tablet, spec.key, 1));
    }

    for (const spec of BUILDING_CATALOG) {
      on(`build-${spec.kind}`, () => {
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        if (!tutorialAllows(spec.kind)) {
          this.touch(tablet, `Not this step - the drill wants ${tutorialWants()}`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "build");
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        tablet.setValue(TabletState, "selectedCraftKind", "none");
        this.hidePlacementMarker();
        tablet.setValue(TabletState, "selectedBuildingKind", spec.kind);
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    on("build-astronaut", () => this.selectBuildUnit(tablet));
    for (let slot = 0; slot < 4; slot += 1) {
      on(`craft-card-${slot}`, () => {
        const page = tablet.getValue(TabletState, "craftPage") ?? 0;
        const spec = CRAFT_CATALOG[page * 4 + slot];
        if (!spec) return;
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        if (!tutorialAllows(spec.kind)) {
          this.touch(tablet, `Not this step - the drill wants ${tutorialWants()}`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "crafts");
        tablet.setValue(TabletState, "selectedCraftKind", spec.kind);
        tablet.setValue(TabletState, "selectedCraftCost", spec.cost);
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        this.hidePlacementMarker();
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    on("craft-prev", () => this.changeCraftPage(tablet, -1));
    on("craft-next", () => this.changeCraftPage(tablet, 1));
    for (let slot = 0; slot < 4; slot += 1) {
      on(`unit-card-${slot}`, () => this.toggleRosterSlot(tablet, slot));
    }
    on("unit-prev", () => this.changeUnitPage(tablet, -1));
    on("unit-next", () => this.changeUnitPage(tablet, 1));
    on("unit-clear", () => {
      clearUnitSelections();
      tablet.setValue(TabletState, "astronaut", null);
      tablet.setValue(TabletState, "astronautIndex", -1);
      this.touch(tablet, "Unit selection cleared");
    });
    on("build-produce", () => this.produceSelectedBuildItem(tablet));
    on("craft-produce", () => this.produceSelectedCraft(tablet));
    // Both tabs cancel the same thing — there is one build queue, so Build and
    // Crafts show the same target and the same label.
    on("build-cancel", () => this.cancelCurrentBuild(tablet));
    on("craft-cancel", () => this.cancelCurrentBuild(tablet));
    on("unit-destroy", () => this.destroySelectedUnits(tablet));
  }

  // The Build tab's one destructive action. It does not care what is selected:
  // it cancels the build an astronaut is actually working on, and if nobody has
  // started anything it cancels the FIRST in the queue — so repeated presses
  // unwind the queue from the front. Clicking a site on the board overrides the
  // target, for when you want a specific one. Refund is full: the crystals were
  // taken at placement and nothing was finished.
  private cancelCurrentBuild(tablet: Entity): void {
    const clicked = tablet.getValue(TabletState, "selectedSite") as Entity | null;
    const site =
      clicked && this.isLiveSite(clicked) ? clicked : currentBuildTarget();
    if (!site) {
      this.touch(tablet, "No build to cancel", "error");
      return;
    }
    const result = destroyOwnEntity(site);
    tablet.setValue(TabletState, "selectedSite", null);
    tablet.setValue(TabletState, "selectedSiteIndex", -1);
    boardState.selectedSite = null;
    this.touch(
      tablet,
      result.ok
        ? `${result.label} cancelled. ${result.refund} crystals refunded`
        : (result.reason ?? "Cannot cancel that"),
      result.ok ? "success" : "error",
    );
  }

  private destroySelectedUnits(tablet: Entity): void {
    const units = getSelectedUnits();
    if (units.length === 0) {
      // Turrets live in this roster too, so this is also where a FINISHED
      // building gets destroyed — the capability lost when the Crafts tab
      // button was removed.
      const building = tablet.getValue(TabletState, "focusBuilding") as
        | Entity
        | null;
      if (building?.hasComponent(Building)) {
        const refusal = canDestroy(building);
        if (refusal) {
          this.touch(tablet, refusal.reason ?? "Cannot destroy that", "error");
          return;
        }
        const result = destroyOwnEntity(building);
        tablet.setValue(TabletState, "focusBuilding", null);
        tablet.setValue(TabletState, "focusBuildingIndex", -1);
        this.touch(
          tablet,
          `${result.label} destroyed. ${result.refund} crystals refunded`,
          "success",
        );
        return;
      }
      this.touch(tablet, "Select units to destroy", "error");
      return;
    }
    let refunded = 0;
    let destroyed = 0;
    for (const unit of units) {
      const result = destroyOwnEntity(unit);
      if (!result.ok) continue;
      refunded += result.refund;
      destroyed += 1;
    }
    clearUnitSelections();
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    updateCommandGridVisibility();
    this.touch(
      tablet,
      `${destroyed} unit${destroyed === 1 ? "" : "s"} destroyed. ${refunded} crystals refunded`,
      destroyed > 0 ? "success" : "error",
    );
  }

  private isLiveSite(site: Entity): boolean {
    return (
      site.hasComponent(ConstructionSite) ||
      site.hasComponent(CraftProductionSite)
    );
  }

  private changeCraftPage(tablet: Entity, direction: number): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const current = tablet.getValue(TabletState, "craftPage") ?? 0;
    const next = Math.max(0, Math.min(pageCount - 1, current + direction));
    if (next === current) return;
    tablet.setValue(TabletState, "craftPage", next);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    updateCommandGridVisibility();
    this.touch(tablet, `Craft catalog page ${next + 1} of ${pageCount}`);
  }

  private openCrafts(tablet: Entity): void {
    if (!(tablet.getValue(TabletState, "spawnBuilding") as Entity | null)) {
      const commandCenter = boardState.commandCenter;
      if (commandCenter) {
        tablet.setValue(TabletState, "spawnBuilding", commandCenter);
        tablet.setValue(TabletState, "spawnBuildingIndex", commandCenter.index);
      }
    }
    this.setView(tablet, "crafts", "Choose a craft to produce");
  }

  private openUnits(tablet: Entity): void {
    tablet.setValue(TabletState, "unitFilter", "all");
    tablet.setValue(TabletState, "unitPage", 0);
    this.setView(tablet, "units", "All live units");
  }

  private setView(tablet: Entity, view: string, status: string): void {
    tablet.setValue(TabletState, "view", view);
    // Switching tabs drops the site selection, so Cancel can never act on
    // something the player has stopped looking at.
    tablet.setValue(TabletState, "selectedSite", null);
    tablet.setValue(TabletState, "selectedSiteIndex", -1);
    boardState.selectedSite = null;
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    updateCommandGridVisibility();
    this.touch(tablet, status);
  }

  private touch(tablet: Entity, status: string, statusKind = "info"): void {
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private applyView(view: string): void {
    for (const name of ["overview", "build", "crafts", "units", "settings"]) {
      const display = view === name ? "flex" : "none";
      this.setProps(`${name}-view`, display, { display });
    }
    const tabs = [
      ["tab-overview", "overview"],
      ["tab-build", "build"],
      ["tab-crafts", "crafts"],
      ["tab-units", "units"],
      ["tab-settings", "settings"],
    ];
    for (const [id, tabView] of tabs) {
      this.applyTabStyle(id, view === tabView);
    }
    // A full restyle overwrites whatever the tutorial pulse last wrote, so the
    // pulse has to forget its state or it would skip the write that puts the
    // highlight back and stay dark until the next flip.
    this.lastTabHintKey = "";
  }

  /**
   * Let the tutorial own the status line while it is running.
   *
   * `TabletState.status` defaults to "Select an astronaut to build", which was
   * true when every match started with one standing by the base. With the
   * tutorial's bare start it is dead-end advice for the whole first drill — it
   * names a unit the player does not have and cannot afford yet.
   *
   * Written only when the tutorial's drill CHANGES, not every frame, so ordinary
   * gameplay feedback ("Not enough crystals", "Astronaut is constructing") still
   * appears and persists until the next drill. The tutorial claims the line at
   * each step; it does not hold it.
   */
  private applyTutorialStatus(tablet: Entity): void {
    const state = boardState.tutorial;
    if (!state || !(state.getValue(TutorialState, "active") ?? false)) {
      this.lastTutorialRevision = Number.NaN;
      return;
    }
    const revision = state.getValue(TutorialState, "revision") ?? 0;
    if (revision === this.lastTutorialRevision) return;
    this.lastTutorialRevision = revision;
    const title = state.getValue(TutorialState, "title") ?? "";
    if (!title) return;
    // The title only — the card already carries the sentence, and a status line
    // repeating it in full would be two places saying the same thing at once.
    this.touch(tablet, title, "info");
  }

  /** A tab's normal styling. Shared with the tutorial pulse, which restores it. */
  private applyTabStyle(id: string, active: boolean): void {
    this.setProps(id, `${active}`, {
      backgroundColor: active
        ? TABLET_TAB_ACTIVE_BACKGROUND
        : TABLET_TAB_INACTIVE_BACKGROUND,
      borderColor: active
        ? TABLET_TAB_ACTIVE_BORDER
        : TABLET_TAB_INACTIVE_BORDER,
      borderWidth: active ? 2 : 1,
    });
  }

  /**
   * Pulse the tab the tutorial is pointing at.
   *
   * The card can say "open the Crafts tab", but on a five-tab strip that is a
   * reading task. This makes it a looking task.
   *
   * Writes only on a state flip — twice a second at most — and always restores
   * the tab's *normal* styling on the dark half and when the hint clears, so
   * the tutorial can never leave a tab stuck looking selected.
   */
  private applyTabHint(delta: number, view: string): void {
    const hint = tutorialTabHint;
    if (!hint) {
      if (this.lastTabHintKey) {
        const [previous] = this.lastTabHintKey.split(":");
        this.applyTabStyle(`tab-${previous}`, view === previous);
        this.lastTabHintKey = "";
        this.tabHintClock = 0;
      }
      return;
    }

    this.tabHintClock += Math.max(0, delta);
    const lit = tabPulseOn(this.tabHintClock, TUTORIAL_TAB_PULSE_SECONDS);
    const key = `${hint}:${lit}`;
    if (key === this.lastTabHintKey) return;

    // The tutorial moved its hint to a different tab: hand the old one back
    // before lighting the new one, or the first stays lit forever.
    const previous = this.lastTabHintKey.split(":")[0];
    if (previous && previous !== hint) {
      this.applyTabStyle(`tab-${previous}`, view === previous);
    }
    this.lastTabHintKey = key;

    if (!lit) {
      this.applyTabStyle(`tab-${hint}`, view === hint);
      return;
    }
    this.setProps(`tab-${hint}`, "tutorial-hint", {
      backgroundColor: TUTORIAL_TAB_PULSE_BACKGROUND,
      borderColor: TUTORIAL_TAB_PULSE_BORDER,
      borderWidth: 3,
    });
  }

  private applySelectedCard(kind: string): void {
    for (const spec of BUILDING_CATALOG.filter((item) => !item.locked)) {
      const selected = spec.kind === kind;
      const allowed = tutorialAllows(spec.kind);
      // The tutorial lock rides on the same pass as selection, so a card can
      // never end up styled selected AND greyed.
      this.setProps(`build-${spec.kind}`, `${selected}:${allowed}`, {
        borderColor: selected
          ? TABLET_SELECTED_BUILD_BORDER
          : TABLET_CARD_BORDER,
        borderWidth: selected ? 3 : 1,
        opacity: allowed ? 1 : TABLET_TUTORIAL_LOCKED_OPACITY,
      });
    }
    const selectedCraftKind =
      this.tabletEntity?.getValue(TabletState, "selectedCraftKind") ?? "none";
    element(this.document!, "build-astronaut")?.setProperties({
      opacity: tutorialAllows(ASTRONAUT_PRODUCTION_SPEC.kind)
        ? 1
        : TABLET_TUTORIAL_LOCKED_OPACITY,
      borderColor:
        selectedCraftKind === ASTRONAUT_PRODUCTION_SPEC.kind && kind === "none"
          ? TABLET_SELECTED_CRAFT_BORDER
          : TABLET_CARD_BORDER,
      borderWidth:
        selectedCraftKind === ASTRONAUT_PRODUCTION_SPEC.kind && kind === "none"
          ? 3
          : 1,
    });
  }

  private applyCraftPage(tablet: Entity, selectedKind: string): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const page = Math.max(
      0,
      Math.min(pageCount - 1, tablet.getValue(TabletState, "craftPage") ?? 0),
    );
    for (let slot = 0; slot < 4; slot += 1) {
      const spec = CRAFT_CATALOG[page * 4 + slot];
      const craftAllowed = !spec || tutorialAllows(spec.kind);
      element(this.document!, `craft-card-${slot}`)?.setProperties({
        display: spec ? "flex" : "none",
        borderColor:
          spec?.kind === selectedKind
            ? TABLET_SELECTED_CRAFT_BORDER
            : TABLET_CARD_BORDER,
        borderWidth: spec?.kind === selectedKind ? 3 : 1,
        // Greyed while the tutorial is asking for something else. The card stays
        // visible on purpose — hiding it would teach that the game has fewer
        // options than it does.
        opacity: craftAllowed ? 1 : TABLET_TUTORIAL_LOCKED_OPACITY,
      });
      if (!spec) continue;
      this.setProps(`craft-image-${slot}`, spec.image, { src: spec.image });
      this.setText(`craft-name-${slot}`, spec.label);
      this.setText(`craft-cost-${slot}`, `${spec.cost} crystals`);
    }
    this.setText("craft-page-label", `Page ${page + 1} / ${pageCount}`);
    const prevOn = page > 0;
    const nextOn = page < pageCount - 1;
    this.setProps("craft-prev", `${prevOn}`, { opacity: prevOn ? 1 : 0.35 });
    this.setProps("craft-next", `${nextOn}`, { opacity: nextOn ? 1 : 0.35 });
  }

  private adjustSetting(
    tablet: Entity,
    key: DebugSettingKey,
    direction: number,
  ): void {
    const spec = DEBUG_SETTINGS_CATALOG.find((item) => item.key === key);
    const settings = boardState.debugSettings;
    if (!spec || !settings) return;
    const current = (settings.getValue(DebugSettings, spec.key) as number) ?? spec.min;
    const raw = current + spec.step * direction;
    const rounded = Math.round(raw / spec.step) * spec.step;
    const next = Math.min(spec.max, Math.max(spec.min, rounded));
    settings.setValue(DebugSettings, spec.key, next);
    settings.setValue(
      DebugSettings,
      "revision",
      (settings.getValue(DebugSettings, "revision") ?? 0) + 1,
    );
    if (spec.key === "turretRange") refreshTurretRangeRingGeometry();
    if (
      spec.key === "astronautAttackRange" ||
      spec.key === "craftRacerAttackRange"
    ) {
      refreshUnitAttackRangeRingGeometry();
    }
    this.applyHealthSetting(spec.key, current, next);
    this.touch(
      tablet,
      `${spec.label}: ${this.formatSettingValue(next, spec.decimals)}`,
    );
  }

  private applyHealthSetting(
    key: DebugSettingKey,
    previousValue: number,
    nextValue: number,
  ): void {
    if (key === "buildingHealthScale") {
      for (const building of this.queries.buildings.entities) {
        this.setEntityMaxHealth(
          building,
          currentBuildingMaxHealth(building.getValue(Building, "kind") ?? ""),
        );
      }
      return;
    }
    if (key === "alienHealthScale") {
      const ratio = nextValue / Math.max(0.01, previousValue);
      for (const enemy of this.queries.enemies.entities) {
        const previousMax =
          enemy.getValue(Health, "max") ??
          currentEnemyMaxHealth(enemy.getValue(Enemy, "kind") ?? "alien");
        this.setEntityMaxHealth(
          enemy,
          Math.round(previousMax * ratio),
        );
      }
      return;
    }
    if (
      key !== "astronautHealth" &&
      key !== "craftRacerHealth" &&
      key !== "craftMinerHealth"
    ) {
      return;
    }
    for (const unit of this.queries.units.entities) {
      const kind = unit.getValue(Unit, "kind") ?? "";
      if (
        (key === "astronautHealth" && kind !== "astronaut") ||
        (key === "craftRacerHealth" && kind !== "racer") ||
        (key === "craftMinerHealth" && kind !== "miner")
      ) {
        continue;
      }
      this.setEntityMaxHealth(unit, currentUnitMaxHealth(kind));
    }
  }

  private setEntityMaxHealth(entity: Entity, nextMax: number): void {
    const previousMax = Math.max(1, entity.getValue(Health, "max") ?? nextMax);
    const previousCurrent = Math.max(
      0,
      entity.getValue(Health, "current") ?? previousMax,
    );
    const max = Math.max(1, Math.round(nextMax));
    const current = Math.min(
      max,
      Math.max(0, previousCurrent + max - previousMax),
    );
    entity.setValue(Health, "max", max);
    entity.setValue(Health, "current", current);
    updateHealthBar(entity);
  }

  private applySettingsView(): void {
    const settings = boardState.debugSettings;
    if (!settings) return;
    for (const spec of DEBUG_SETTINGS_CATALOG) {
      const value = (settings.getValue(DebugSettings, spec.key) as number) ?? spec.min;
      this.setText(
        `setting-${spec.key}-value`,
        this.formatSettingValue(value, spec.decimals),
      );
    }
  }

  private formatSettingValue(value: number, decimals: number): string {
    return value.toFixed(decimals);
  }

  private applyUnitPage(tablet: Entity): void {
    const roster = this.liveRoster();
    const filter = tablet.getValue(TabletState, "unitFilter") ?? "all";
    const page = paginateRoster(
      roster,
      filter,
      tablet.getValue(TabletState, "unitPage") ?? 0,
    );
    const totals = countRosterKinds(roster);
    const selectedCount =
      boardState.selection?.getValue(SelectionState, "selectedCount") ?? 0;
    this.setText(
      "unit-filter-label",
      filter === "all"
        ? `All units (${page.total})`
        : `${this.buildingLabel(filter)} (${page.total})`,
    );
    this.setText(
      "unit-selected-label",
      `${selectedCount} selected`,
    );

    for (let slot = 0; slot < 4; slot += 1) {
      const entry = page.entries[slot];
      if (entry) {
        // Turrets are not part of the unit selection, so "selected" for them
        // means "this is the turret whose range ring is showing".
        const selected = entry.building
          ? boardState.selectedTurret === entry.entity
          : (entry.entity.getValue(UnitSelection, "selected") ?? false);
        this.setProps(`unit-card-${slot}`, `live:${selected}`, {
          backgroundColor: selected
            ? TABLET_SELECTED_UNIT_BACKGROUND
            : TABLET_UNIT_BACKGROUND,
          borderColor: selected
            ? TABLET_SELECTED_CRAFT_BORDER
            : TABLET_CARD_BORDER,
          borderWidth: selected ? 3 : 1,
          cursor: "pointer",
        });
        const unitSrc = this.unitImage(entry.entity, entry.kind);
        this.setProps(`unit-image-${slot}`, `flex:${unitSrc}`, {
          display: "flex",
          src: unitSrc,
        });
        this.setText(`unit-name-${slot}`, this.unitLabel(entry.kind));
        this.setText(
          `unit-meta-${slot}`,
          `#${entry.index} - ${totals.get(entry.kind) ?? 1} total`,
        );
        continue;
      }

      const locked = slot === 3;
      this.setProps(`unit-card-${slot}`, `empty:${locked}`, {
        backgroundColor: locked
          ? TABLET_LOCKED_UNIT_BACKGROUND
          : TABLET_EMPTY_UNIT_BACKGROUND,
        borderColor: locked ? TABLET_LOCKED_UNIT_BORDER : TABLET_EMPTY_UNIT_BORDER,
        borderWidth: 1,
        cursor: "default",
      });
      this.setProps(`unit-image-${slot}`, "none", { display: "none" });
      this.setText(`unit-name-${slot}`, locked ? "Locked" : "Empty");
      this.setText(
        `unit-meta-${slot}`,
        locked ? "Future reinforcement" : "No live unit in this slot",
      );
    }

    this.setText(
      "unit-page-label",
      `Page ${page.page + 1} / ${page.pageCount}`,
    );
    this.setProps("unit-prev", `${page.page > 0}`, {
      opacity: page.page > 0 ? 1 : 0.35,
    });
    this.setProps("unit-next", `${page.page < page.pageCount - 1}`, {
      opacity: page.page < page.pageCount - 1 ? 1 : 0.35,
    });
  }

  // Turrets are Buildings, not Units, so they never appeared here. They are
  // still forces you own and want to find, so the roster lists them alongside
  // the units — marked `building` because they select and destroy differently.
  private liveRoster(): LiveRosterEntry[] {
    const roster: LiveRosterEntry[] = Array.from(
      this.queries.units.entities,
      (entity) => ({
        entity,
        index: entity.index,
        kind: entity.getValue(Unit, "kind") ?? "unknown",
        category:
          entity.getValue(UnitSelection, "category") ?? "command-center",
        building: false,
      }),
    );
    for (const entity of this.queries.buildings.entities) {
      if (entity.getValue(Building, "kind") !== "turret") continue;
      roster.push({
        entity,
        index: entity.index,
        kind: "turret",
        // Matches the filter a board click sets, so clicking a turret on the
        // board and then opening Units narrows to turrets.
        category: "turret",
        building: true,
      });
    }
    return roster;
  }

  private toggleRosterSlot(tablet: Entity, slot: number): void {
    const page = paginateRoster(
      this.liveRoster(),
      tablet.getValue(TabletState, "unitFilter") ?? "all",
      tablet.getValue(TabletState, "unitPage") ?? 0,
    );
    const entry = page.entries[slot];
    if (!entry) return;
    // A turret card behaves exactly like clicking the turret on the board:
    // toggle its range ring and make it the focused building, which is what the
    // Destroy action targets when no units are selected.
    if (entry.building) {
      const shown = toggleTurretRangeRing(this.world, entry.entity);
      tablet.setValue(TabletState, "focusBuilding", shown ? entry.entity : null);
      tablet.setValue(
        TabletState,
        "focusBuildingIndex",
        shown ? entry.entity.index : -1,
      );
      this.touch(
        tablet,
        shown
          ? `Turret #${entry.index} selected`
          : `Turret #${entry.index} deselected`,
      );
      return;
    }
    const selected = toggleUnitSelection(this.world, entry.entity);
    const single = getSingleSelectedUnit();
    const astronaut =
      single?.getValue(Unit, "kind") === "astronaut" ? single : null;
    tablet.setValue(TabletState, "astronaut", astronaut);
    tablet.setValue(TabletState, "astronautIndex", astronaut?.index ?? -1);
    this.touch(
      tablet,
      `${selected ? "Selected" : "Deselected"} ${this.unitLabel(entry.kind)} #${entry.index}`,
    );
  }

  private changeUnitPage(tablet: Entity, direction: number): void {
    const current = tablet.getValue(TabletState, "unitPage") ?? 0;
    const page = paginateRoster(
      this.liveRoster(),
      tablet.getValue(TabletState, "unitFilter") ?? "all",
      current,
    );
    const next = Math.max(0, Math.min(page.pageCount - 1, current + direction));
    if (next === current) return;
    tablet.setValue(TabletState, "unitPage", next);
    this.touch(tablet, `Unit roster page ${next + 1} of ${page.pageCount}`);
  }

  // No production building to select any more, and none needs to exist. Pick a
  // craft, then pick a tile.
  private produceSelectedCraft(tablet: Entity): void {
    const game = boardState.gameState;
    const spec = getProductionSpec(
      tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
    );
    const validation = validateCraftPurchase({
      spec,
      crystals: game?.getValue(GameState, "crystals") ?? 0,
      // Tile availability is validated when the player clicks the board.
      tileAvailable: true,
    });
    if (!validation.ok || !spec || !game) {
      this.touch(
        tablet,
        validation.ok ? "Craft production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "craftPlacementActive", true);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    clearUnitSelections();
    updateCommandGridVisibility();
    this.touch(tablet, `Choose an open tile for ${spec.label}`);
  }

  private selectBuildUnit(tablet: Entity): void {
    const commandCenter = boardState.commandCenter;
    if (commandCenter) {
      tablet.setValue(TabletState, "spawnBuilding", commandCenter);
      tablet.setValue(TabletState, "spawnBuildingIndex", commandCenter.index);
    }
    tablet.setValue(TabletState, "view", "build");
    tablet.setValue(TabletState, "selectedBuildingKind", "none");
    tablet.setValue(TabletState, "selectedCraftKind", ASTRONAUT_PRODUCTION_SPEC.kind);
    tablet.setValue(TabletState, "selectedCraftCost", ASTRONAUT_PRODUCTION_SPEC.cost);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    updateCommandGridVisibility();
    this.touch(
      tablet,
      `${ASTRONAUT_PRODUCTION_SPEC.label}: ${ASTRONAUT_PRODUCTION_SPEC.cost} crystals`,
    );
  }

  private produceSelectedBuildItem(tablet: Entity): void {
    if (
      (tablet.getValue(TabletState, "selectedCraftKind") ?? "none") ===
        ASTRONAUT_PRODUCTION_SPEC.kind &&
      (tablet.getValue(TabletState, "selectedBuildingKind") ?? "none") === "none"
    ) {
      this.produceSelectedCraft(tablet);
      return;
    }
    this.produceSelectedBuilding(tablet);
  }

  // Place-first: no astronaut is required to start a build order. The site is
  // placed on the board and an available astronaut comes to it.
  private produceSelectedBuilding(tablet: Entity): void {
    const spec = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const validation = validateBuildOrder({
      spec,
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      // Footprint and path are validated against the tile the player clicks.
      footprintValid: true,
      pathFound: true,
    });
    if (!validation.ok || !spec) {
      this.touch(
        tablet,
        validation.ok ? "Building production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "buildPlacementActive", true);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    updateCommandGridVisibility();
    this.touch(tablet, `Choose a build tile for ${spec.label}`);
  }

  private hidePlacementMarker(): void {
    if (boardState.buildMarker?.object3D) {
      boardState.buildMarker.object3D.visible = false;
    }
  }

  private buildingLabel(kind: string): string {
    if (kind === "command-center") return "Command Center";
    if (kind === "factory") return "Aircraft Factory";
    if (kind === "hangar") return "Hangar";
    if (kind === "turret") return "Turret";
    return kind;
  }

  private unitLabel(kind: string): string {
    if (kind === "astronaut") return "Astronaut";
    if (kind === "turret") return "Turret";
    return getCraftSpec(kind)?.label ?? kind;
  }

  private unitImage(unit: Entity, kind: string): string {
    if (kind === "turret") {
      return getBuildingSpec("turret")?.image ?? "/images/turret_single.png";
    }
    if (kind === "astronaut") {
      return unit.object3D?.name.includes("B")
        ? "/images/astronautB.png"
        : "/images/astronautA.png";
    }
    return getCraftSpec(kind)?.image ?? "/images/rover.png";
  }

  // Phase A dirty guard. `setProperties` allocates and dirties UIKit layout, and
  // a full render touches ~43 elements of which typically one or two actually
  // changed. Measured on Quest 2026-08-09: `PanelUI` is a fixed ~6.8 ms burst
  // about twice a second, identical at every level while the scene tripled —
  // scene-independent, so it is the rewrite itself. Skipping unchanged writes is
  // the direct attack on that. Keyed on the element object, not the id, because
  // ids are reused across pages (`craft-name-${slot}`) and a WeakMap cannot go
  // stale when the document is rebuilt.
  private setText(id: string, text: string): void {
    const target = element(this.document!, id);
    if (!target) return;
    if (this.lastSetText.get(target) === text) return;
    this.lastSetText.set(target, text);
    target.setProperties({ text });
  }

  // Same guard for the non-text writes (colours, borders, opacity, display,
  // image src). These are the most repetitive of all — tab colours and card
  // borders are rewritten on every render and change only when the selection
  // does. Compares a caller-supplied signature rather than the object, so one
  // string covers a multi-property write.
  private setProps(
    id: string,
    signature: string,
    properties: Record<string, unknown>,
  ): void {
    const target = element(this.document!, id);
    if (!target) return;
    if (this.lastSetProps.get(target) === signature) return;
    this.lastSetProps.set(target, signature);
    target.setProperties(properties);
  }
}
