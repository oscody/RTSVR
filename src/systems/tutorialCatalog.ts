/**
 * Tutorial script data — the whole tutorial expressed as configuration.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * Nothing here imports IWSDK, ECS or Three. This file is data plus the master
 * switch, so the rules module and its tests can consume it without a world.
 */

import type { EnemyKind, WaveEdge } from "./waveCatalog.ts";

// Default for the whole tutorial. This seeds `DebugSettings.tutorialEnabled`,
// which is what the runtime actually reads — the same relationship
// ALIEN_MOVE_SPEED has with DebugSettings.alienMoveSpeed. Change this to change
// the default; use the tablet's Settings tab to change it live.
//
// Off means TutorialSystem returns immediately: no card, no arrow, no wave hold,
// no wave-0 level — the game behaves exactly as it does today.
//
// There is still no first-run detection and no Skip button.
export const TUTORIAL_ENABLED = true;

/**
 * Where the bobbing arrow points. Resolved to a world position by the system,
 * so the catalog stays pure data.
 *
 * `commandCenter` and `threatTile` are derived from the base, which can be
 * destroyed (`boardState.commandCenter` is nulled at `combat.ts:300`). Both
 * must resolve to "no target" in that case rather than falling back to the
 * origin — see `arrowNeedsCommandCenter`.
 */
/**
 * Which side a path belongs to. Red is theirs, blue is yours — the whole colour
 * language, and enough for a player to read "something is coming HERE, put
 * something THERE" with no text at all.
 */
export type PathStyle = "friendly" | "hostile";

/** Two ends of a ground route. See `TutorialDrill.path`. */
export interface TutorialPath {
  style: PathStyle;
  from: ArrowTarget;
  to: ArrowTarget;
}

/**
 * The three moments of a drill.
 *
 * `meet` only exists for drills that declare one — it is the beat between "the
 * thing has arrived" and "now deal with it", which is where the world freezes
 * and the player is asked to actually look at what turned up.
 */
export type DrillPhase = "intro" | "meet" | "doing";

/** One target, several, or none. See `TutorialDrill.arrows`. */
export type ArrowTargets = ArrowTarget | readonly ArrowTarget[] | null;

export type ArrowTarget =
  | { kind: "commandCenter" }
  | { kind: "nearestUnit"; unit: string }
  | { kind: "nearestCrystal" }
  | { kind: "tile"; x: number; y: number }
  // Points a cone at the tablet itself. The tab PULSE is no longer declared
  // here — it is derived from what the drill asks you to build and whether you
  // can afford it yet (`tabHintFor`), so every build step behaves alike.
  | { kind: "tabletTab"; tab: "build" | "crafts" }
  | { kind: "nearestEnemy" }
  /** Base tile stepped toward the incoming spawn edge. */
  | { kind: "threatTile" }
  /** Between a threatened unit and whatever threatens it. */
  | { kind: "interceptTile" }
  /**
   * Wherever this unit is currently headed.
   *
   * Deliberately general rather than miner-specific: any ordered unit resolves
   * through `Unit.orderX/orderY`, and a miner mid-cycle resolves through its
   * mining stage. That is what lets one path declaration serve "the miner goes
   * to the crystals and back" and "your astronaut is walking to the tile you
   * picked" without either being special-cased.
   */
  | { kind: "unitDestination"; unit: string };

/**
 * One drill is the whole "meet a unit, make one, use it" loop:
 *
 *   introduce → player creates it → place it → an opponent arrives → beat it
 *
 * Adding a unit to the tutorial is one entry in TUTORIAL_DRILLS. Wave 0's
 * roster is derived from these, so the script and the enemies cannot drift
 * apart the way two hand-maintained lists would.
 */
export interface TutorialDrill {
  id: string;
  /** null for pure-instruction drills (orientation, the sign-off). */
  create: {
    /** buildingCatalog vs craftCatalog. */
    via: "build" | "produce";
    kind: string;
  } | null;
  /** Where the card and arrow steer the player. Advisory, never enforced. */
  placement: "towardThreat" | "anywhere" | null;
  /**
   * Floor on how long this card is shown, in seconds, regardless of the
   * trigger. A step whose condition is *already* true when it begins would
   * otherwise flash past unread — which is exactly what happened to the
   * orientation beat: the desktop camera already faces the base, so the gaze
   * passed on the first 4 Hz sample and the player never saw the card.
   *
   * The trigger still decides *whether* a drill completes; this only decides
   * that it cannot complete instantly.
   */
  minSeconds?: number;
  /** Units this drill leaves the player depending on; a death pushes recovery. */
  keepAlive?: readonly string[];
  /** What releases this drill's opponent. Timers are a last resort. */
  trigger:
    | { kind: "minerTrips"; count: number }
    /**
     * Wait until the player has banked this many crystals.
     *
     * **Omit `amount` to derive it from the price of the unit this drill
     * teaches** — which is what every real drill does. The gate and the price
     * were separate numbers until 2026-09-03, and they drifted the moment the
     * catalog was repriced: the turret drill still opened at 30 crystals for a
     * turret that had gone to 80, so the drill told the player to build
     * something they could not afford. Deriving it makes that unrepresentable.
     *
     * An explicit amount is kept for tests that need a deliberately wrong gate.
     */
    | { kind: "crystalsAtLeast"; amount?: number }
    /**
     * Completes when the player actually looks at the thing being named.
     *
     * `target` is a full `ArrowTarget`, so this works for ANY subject the
     * tutorial can already point at — the base, a unit, an alien, a building.
     * The focus effect (dim the world, light the subject, ring it) follows the
     * same target, so introducing a new thing is one drill entry rather than a
     * new mechanism.
     */
    | { kind: "lookedAt"; target: ArrowTarget }
    /** Last resort for beats with genuinely nothing to react to. */
    | { kind: "dwellSeconds"; seconds: number }
    | { kind: "immediate" };
  /** Released on `trigger`. null for non-combat drills (the miner). */
  opponent: {
    enemy: EnemyKind;
    count: number;
    /** "farFromMiner" resolves at release time to the mine's far corner. */
    spawn: WaveEdge | "farFromMiner";
    /** What it should head for, so the drill's lesson is reliable. */
    hunts?: "miner" | "commandCenter";
  } | null;
  /**
   * All tutorial copy lives here — nowhere else in src/ has tutorial strings.
   * `title` is a 2-4 word heading; the sentences go in the body lines. Reading
   * is expensive in a headset, so the heading has to be glanceable on its own.
   */
  cards: {
    title: string;
    intro: string;
    /** Shown while the world is frozen and the player is looking. */
    meet: string;
    doing: string;
    cleared: string;
  };
  /**
   * The meet beat: freeze the world, ring the thing that just arrived, and wait
   * for the player to look at it.
   *
   * null means the drill has no such beat and runs `intro -> doing` as before.
   * Every combat drill declares one; instruction drills do not, because nothing
   * arrives during them.
   */
  meet: { gaze: ArrowTarget; seconds: number } | null;
  /**
   * A flowing ground path between two things — see `tutorialPath.ts`.
   *
   * Both ends are ordinary `ArrowTarget`s, so any drill can draw a route
   * between anything the tutorial can already point at. Hidden automatically
   * when either end cannot be resolved, so a drill may declare a path for a
   * unit the player has not built yet.
   *
   * Split by card phase, exactly like `cards` and `arrows`, because the two
   * phases usually want different KINDS of path: before the player acts it is
   * an instruction ("send it there"), afterwards a forecast ("this is where it
   * is going"). See "forecast or instruction?" in the plan — they answer
   * different questions and only one of them has to match real movement.
   */
  path: {
    intro: readonly TutorialPath[];
    meet: readonly TutorialPath[];
    doing: readonly TutorialPath[];
  };
  /**
   * Where to point, per card phase — mirroring `cards`, because the script
   * genuinely needs two: "Build tab, THEN the tile you should place on".
   * `hasDrillStarted()` picks which. null means point at nothing.
   *
   * An ARRAY points at several things at once. Some instructions are about a
   * relationship rather than a place — "send this unit to that patch" is two
   * subjects, and one cone can only ever say half of it.
   */
  arrows: { intro: ArrowTargets; meet: ArrowTargets; doing: ArrowTargets };
}

/**
 * The default script: miner → astronaut → fighter → turret.
 *
 * The order is forced, not chosen. STARTING_CRYSTALS is 0, so mining is the only
 * action available at t=0; and astronaut production is the one path exempt from
 * requiring a builder, so it must precede the fighter and the turret, which both
 * need one. Each drill is what unlocks the next.
 */
export const TUTORIAL_DRILLS: readonly TutorialDrill[] = [
  {
    // Orientation. Before anything else the player has to know which thing on
    // the board is theirs and what losing it costs — every later drill is in
    // service of defending it.
    id: "orient",
    create: null,
    placement: null,
    // Event, not a timer. A dwell expires whether or not the player ever found
    // their base; this completes only once they have actually looked at it, and
    // the gaze ring draws that clock.
    trigger: { kind: "lookedAt", target: { kind: "commandCenter" } },
    // Long enough to read two lines, spent in LOOKING rather than in elapsed
    // time. Without it, anyone already facing their base skips the only step
    // that explains what it is.
    minSeconds: 4,
    // No meet beat: nothing arrives during orientation.
    meet: null,
    opponent: null,
    path: { intro: [], meet: [], doing: [] },
    arrows: {
      intro: { kind: "commandCenter" },
      meet: null,
      doing: { kind: "commandCenter" },
    },
    cards: {
      title: "This is your command center",
      intro: "Lose it and the match ends. Everything else you build is there to protect it.",
      meet: "",
      doing: "Lose it and the match ends. Everything else you build is there to protect it.",
      cleared: "",
    },
  },
  {
    id: "mine",
    // The player already owns a miner — this drill is about commanding it.
    create: null,
    placement: null,
    keepAlive: ["miner"],
    // Four trips = 40 crystals, comfortably above the astronaut the next drill
    // teaches. Deliberately a TRIP count and not a crystal count: this drill is
    // about commanding the miner, so it must not move when a unit is repriced.
    // Completing this releases the first alien.
    trigger: { kind: "minerTrips", count: 4 },
    meet: null,
    // The miner cannot attack, so this drill must have no opponent.
    opponent: null,
    path: {
      // Before the player acts: where to SEND it. An instruction — it predicts
      // nothing, so it does not have to match any movement.
      intro: [
        {
          style: "friendly",
          from: { kind: "nearestUnit", unit: "miner" },
          to: { kind: "nearestCrystal" },
        },
      ],
      meet: [],
      // Once it is working: where it is actually going, out and back with the
      // mining cycle. A forecast, and it matches.
      doing: [
        {
          style: "friendly",
          from: { kind: "nearestUnit", unit: "miner" },
          to: { kind: "unitDestination", unit: "miner" },
        },
      ],
    },
    // BOTH ends of the relationship, in both phases: one cone can only ever
    // name half of "that craft goes to those crystals".
    arrows: {
      intro: [
        { kind: "nearestUnit", unit: "miner" },
        { kind: "nearestCrystal" },
      ],
      meet: null,
      doing: [
        { kind: "nearestUnit", unit: "miner" },
        { kind: "nearestCrystal" },
      ],
    },
    cards: {
      title: "Mine your first crystals",
      intro: "Those blue crystals are your income. Click your mining craft, then click the nearest crystals.",
      meet: "",
      doing: "It mines and carries it back on its own. Watch the gem count climb.",
      cleared: "That is your economy. It keeps running while you fight.",
    },
  },
  {
    id: "astronaut",
    create: { via: "produce", kind: "astronaut" },
    placement: "anywhere",
    // NOT ["miner", "astronaut"]: a drill cannot demand the unit it teaches.
    keepAlive: ["miner"],
    trigger: { kind: "crystalsAtLeast" },
    meet: { gaze: { kind: "nearestEnemy" }, seconds: 3 },
    // Hunts the miner on purpose: being threatened is the most teachable moment
    // in the tutorial, and it spawns far enough away to leave ~24s to react.
    opponent: { enemy: "alien", count: 1, spawn: "farFromMiner", hunts: "miner" },
    path: {
      intro: [],
      // While frozen: its route to your miner, in red. The threat, drawn.
      meet: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "nearestUnit", unit: "miner" },
        },
      ],
      // Then both: what is coming, and what to do about it.
      //
      // The blue route ends AT THE ALIEN, because that is literally the click
      // the game wants: `interaction.ts` issues an attack by ordering the
      // selected unit onto the enemy's own tile. A route to the miner would
      // point at a square where clicking achieves nothing.
      //
      // Only drawn once the astronaut exists — that falls out of `nearestUnit`
      // failing to resolve rather than needing a check.
      doing: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "nearestUnit", unit: "miner" },
        },
        {
          style: "friendly",
          from: { kind: "nearestUnit", unit: "astronaut" },
          to: { kind: "nearestEnemy" },
        },
      ],
    },
    arrows: {
      intro: { kind: "nearestUnit", unit: "miner" },
      // The thing that arrived, and where it is walking — the two ends of the
      // red route. "This is coming, and it is going THERE."
      meet: [{ kind: "nearestEnemy" }, { kind: "nearestUnit", unit: "miner" }],
      doing: [{ kind: "nearestEnemy" }, { kind: "nearestUnit", unit: "miner" }],
    },
    cards: {
      title: "Defend your miner",
      intro: "Your crystals are stacking up. Something will come for them.",
      meet: "Something has landed. Follow the red marker and find it — it is walking at your mining craft.",
      doing: "Amber means spotted. Make an astronaut and put it in the way.",
      cleared: "Astronauts fight, and they build. You will need one for what is next.",
    },
  },
  {
    id: "fighter",
    create: { via: "produce", kind: "fighter" },
    placement: "anywhere",
    // Fighter production requires a BUILDER, so this drill depends on the
    // astronaut the previous one taught.
    keepAlive: ["miner", "astronaut"],
    trigger: { kind: "crystalsAtLeast" },
    meet: { gaze: { kind: "nearestEnemy" }, seconds: 3 },
    opponent: { enemy: "alienDrake", count: 1, spawn: "south", hunts: "commandCenter" },
    path: {
      intro: [],
      meet: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "commandCenter" },
        },
      ],
      doing: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "commandCenter" },
        },
        {
          style: "friendly",
          from: { kind: "nearestUnit", unit: "fighter" },
          to: { kind: "nearestEnemy" },
        },
      ],
    },
    arrows: {
      // No tablet cone: the tab PULSE is derived from affordability now.
      intro: { kind: "nearestUnit", unit: "miner" },
      meet: [{ kind: "nearestEnemy" }, { kind: "commandCenter" }],
      doing: [{ kind: "nearestEnemy" }, { kind: "commandCenter" }],
    },
    cards: {
      title: "Meet the flyer",
      intro: "Something is flying in.",
      meet: "A drake is in the air. Follow the red marker — it is going straight for your command center.",
      doing: "Fighter craft are fast. Produce one and send it at the flyer.",
      cleared: "Different enemies want different answers.",
    },
  },
  {
    id: "turret",
    create: { via: "build", kind: "turret" },
    // The one drill where direction matters — a turret behind the base never
    // fires. Advisory: the step completes on placement anywhere.
    placement: "towardThreat",
    // Turret construction needs an astronaut to build it.
    keepAlive: ["miner", "astronaut"],
    trigger: { kind: "crystalsAtLeast" },
    meet: { gaze: { kind: "nearestEnemy" }, seconds: 3 },
    opponent: {
      enemy: "strongAlienMech",
      count: 1,
      spawn: "south",
      hunts: "commandCenter",
    },
    path: {
      // No blue route on this drill. A turret is BUILT, not sent — there is no
      // unit walking anywhere, so a blue trail would be drawing a journey that
      // never happens. The `threatTile` cone already says where to put it.
      intro: [],
      meet: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "commandCenter" },
        },
      ],
      doing: [
        {
          style: "hostile",
          from: { kind: "nearestEnemy" },
          to: { kind: "commandCenter" },
        },
      ],
    },
    arrows: {
      intro: { kind: "commandCenter" },
      meet: [{ kind: "nearestEnemy" }, { kind: "commandCenter" }],
      doing: [{ kind: "nearestEnemy" }, { kind: "threatTile" }],
    },
    cards: {
      title: "Build a turret",
      intro: "Turrets fight on their own. Build one on the side the aliens come from.",
      meet: "A war machine, heavier than anything yet. Follow the red marker and see where it is headed.",
      doing: "Your turret fires by itself. Help it finish this one.",
      cleared: "Wave cleared. Crystals keep coming, the waves get bigger. Good luck.",
    },
  },
  {
    // Sign-off. Not a lesson — it closes the tutorial and hands the player to
    // the real ladder, so they know the training wheels are off.
    id: "done",
    create: null,
    placement: null,
    trigger: { kind: "dwellSeconds", seconds: 8 },
    meet: null,
    opponent: null,
    path: { intro: [], meet: [], doing: [] },
    // Nothing left to point at — the tutorial is handing over.
    arrows: { intro: null, meet: null, doing: null },
    cards: {
      title: "Wave cleared",
      intro: "Crystals keep coming and the waves get bigger. Good luck.",
      meet: "",
      doing: "Crystals keep coming and the waves get bigger. Good luck.",
      cleared: "",
    },
  },
];
