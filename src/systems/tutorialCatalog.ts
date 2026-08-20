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
/** Two ends of a ground route. See `TutorialDrill.path`. */
export interface TutorialPath {
  from: ArrowTarget;
  to: ArrowTarget;
}

/** One target, several, or none. See `TutorialDrill.arrows`. */
export type ArrowTargets = ArrowTarget | readonly ArrowTarget[] | null;

export type ArrowTarget =
  | { kind: "commandCenter" }
  | { kind: "nearestUnit"; unit: string }
  | { kind: "nearestCrystal" }
  | { kind: "tile"; x: number; y: number }
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
    | { kind: "crystalsAtLeast"; amount: number }
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
  cards: { title: string; intro: string; doing: string; cleared: string };
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
  path: { intro: TutorialPath | null; doing: TutorialPath | null };
  /**
   * Where to point, per card phase — mirroring `cards`, because the script
   * genuinely needs two: "Build tab, THEN the tile you should place on".
   * `hasDrillStarted()` picks which. null means point at nothing.
   *
   * An ARRAY points at several things at once. Some instructions are about a
   * relationship rather than a place — "send this unit to that patch" is two
   * subjects, and one cone can only ever say half of it.
   */
  arrows: { intro: ArrowTargets; doing: ArrowTargets };
}

/**
 * The default script: miner → astronaut → racer → turret.
 *
 * The order is forced, not chosen. STARTING_CRYSTALS is 0, so mining is the only
 * action available at t=0; and astronaut production is the one path exempt from
 * requiring a builder, so it must precede the racer and the turret, which both
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
    // their base — and from the default XR position the base is BEHIND them, so
    // a timer would routinely elapse while they stare at empty terrain. This
    // completes only once they have actually turned and looked at it.
    trigger: { kind: "lookedAt", target: { kind: "commandCenter" } },
    // Nothing to travel yet — this beat is about noticing, not moving.
    path: { intro: null, doing: null },
    // Long enough to read two lines. Without it, anyone already facing their
    // base skips the only step that explains what it is.
    minSeconds: 4,
    opponent: null,
    arrows: {
      intro: { kind: "commandCenter" },
      doing: { kind: "commandCenter" },
    },
    cards: {
      title: "This is your command center",
      intro: "Lose it and the match ends. Everything else you build is there to protect it.",
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
    // Four trips = 40 crystals, which is what an astronaut (35) costs plus
    // change. Completing this releases the first alien.
    trigger: { kind: "minerTrips", count: 4 },
    // The whole lesson, drawn: this craft goes to that patch — and back again,
    // because `unitDestination` follows the mining cycle rather than a fixed
    // tile.
    path: {
      // Before the player acts: where to SEND it. An instruction — it predicts
      // nothing, so it does not have to match any movement.
      intro: {
        from: { kind: "nearestUnit", unit: "miner" },
        to: { kind: "nearestCrystal" },
      },
      // Once it is working: where it is actually going, which follows the
      // mining cycle out and back. A forecast, and it matches.
      doing: {
        from: { kind: "nearestUnit", unit: "miner" },
        to: { kind: "unitDestination", unit: "miner" },
      },
    },
    // The miner cannot attack, so this drill must have no opponent.
    opponent: null,
    // BOTH, in both phases: this drill is about a relationship — that craft
    // goes to those crystals — and a single cone can only ever name one end of
    // it. The miner first, because it is the thing the player has to click.
    arrows: {
      intro: [
        { kind: "nearestUnit", unit: "miner" },
        { kind: "nearestCrystal" },
      ],
      doing: [
        { kind: "nearestUnit", unit: "miner" },
        { kind: "nearestCrystal" },
      ],
    },
    cards: {
      title: "Mine your first crystals",
      intro: "Those blue crystals are your income. Click your mining craft, then click the nearest crystals.",
      doing: "It mines and carries it back on its own. Watch the gem count climb.",
      cleared: "That is your economy. It keeps running while you fight.",
    },
  },
  {
    id: "astronaut",
    create: { via: "produce", kind: "astronaut" },
    placement: "anywhere",
    // NOT ["miner", "astronaut"]. A drill cannot demand the unit it is about to
    // teach: with the bare start the player has no astronaut when this begins,
    // so keeping one alive read as a LOSS and the drill opened with "Rebuild
    // your astronaut" for one they never had. Losing it mid-drill needs no
    // special case either — the card already says "Make an astronaut and put it
    // in the way", which is the correct instruction either way.
    keepAlive: ["miner"],
    trigger: { kind: "crystalsAtLeast", amount: 35 },
    // "Put it in the way" as a route rather than a sentence. An INSTRUCTION
    // path: it predicts nothing, so a straight line is simply correct.
    path: {
      intro: null, // nothing to send yet — the astronaut does not exist
      doing: {
        from: { kind: "nearestUnit", unit: "astronaut" },
        to: { kind: "interceptTile" },
      },
    },
    // Hunts the miner on purpose: being threatened is the most teachable moment
    // in the tutorial, and it spawns far enough away to leave ~35s to react.
    opponent: { enemy: "alien", count: 1, spawn: "farFromMiner", hunts: "miner" },
    arrows: {
      intro: { kind: "nearestEnemy" },
      doing: { kind: "interceptTile" },
    },
    cards: {
      title: "Defend your miner",
      intro: "An alien has landed. It is heading for your mining craft.",
      doing: "Amber means spotted. Make an astronaut and put it in the way.",
      cleared: "Astronauts fight, and they build. You will need one for what is next.",
    },
  },
  {
    id: "racer",
    create: { via: "produce", kind: "racer" },
    placement: "anywhere",
    // Racer production requires a BUILDER, so this drill genuinely depends on
    // the astronaut the previous one taught — unlike that drill, which cannot
    // depend on the unit it is teaching. Losing the astronaut here needs the
    // recovery prompt, or the player sits unable to produce with no idea why.
    keepAlive: ["miner", "astronaut"],
    trigger: { kind: "crystalsAtLeast", amount: 80 },
    path: {
      intro: null,
      doing: {
        from: { kind: "nearestUnit", unit: "racer" },
        to: { kind: "nearestEnemy" },
      },
    },
    opponent: { enemy: "alienDrake", count: 1, spawn: "south", hunts: "commandCenter" },
    arrows: {
      intro: { kind: "tabletTab", tab: "crafts" },
      doing: { kind: "nearestEnemy" },
    },
    cards: {
      title: "Meet the flyer",
      intro: "Something is flying in.",
      doing: "Racing craft are fast. Produce one and send it at the flyer.",
      cleared: "Different enemies want different answers.",
    },
  },
  {
    id: "turret",
    create: { via: "build", kind: "turret" },
    // The one drill where direction matters — a turret behind the base never
    // fires. Advisory: the step completes on placement anywhere.
    placement: "towardThreat",
    // Turret construction needs an astronaut to build it — same dependency as
    // the racer drill, same reason it must be recoverable.
    keepAlive: ["miner", "astronaut"],
    trigger: { kind: "crystalsAtLeast", amount: 30 },
    // From the base out toward the threat: "build on the side they come from".
    path: {
      intro: { from: { kind: "commandCenter" }, to: { kind: "threatTile" } },
      doing: { from: { kind: "commandCenter" }, to: { kind: "threatTile" } },
    },
    opponent: {
      enemy: "strongAlienMech",
      count: 1,
      spawn: "south",
      hunts: "commandCenter",
    },
    arrows: {
      intro: { kind: "tabletTab", tab: "build" },
      doing: { kind: "threatTile" },
    },
    cards: {
      title: "Build a turret",
      intro: "Turrets fight on their own. Build one on the side the aliens come from.",
      doing: "It fires by itself. Here comes the big one — help it out.",
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
    path: { intro: null, doing: null },
    opponent: null,
    // Nothing left to point at — the tutorial is handing over.
    arrows: { intro: null, doing: null },
    cards: {
      title: "Wave cleared",
      intro: "Crystals keep coming and the waves get bigger. Good luck.",
      doing: "Crystals keep coming and the waves get bigger. Good luck.",
      cleared: "",
    },
  },
];
