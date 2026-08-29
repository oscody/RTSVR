import { Entity, createSystem } from "@iwsdk/core";
import { GRID_SIZE, worldToGrid } from "./board.js";
import { triggerCommandCenterDepositDoors } from "./commandCenterAnimation.js";
import {
  DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
  MINING_GATHER_TIME_SECONDS,
} from "./economyConstants.js";
import {
  advanceMiningCycle,
  selectNearestMiningTarget,
} from "./miningRules.js";
import type {
  MiningCycleState,
  MiningGridPosition,
  MiningStage,
} from "./miningRules.js";
import { matchAcceptsCommands } from "./matchStart.js";
import { findApproachTile } from "./navigation.js";
import {
  DebugSettings,
  Enemy,
  GameState,
  GameStats,
  MatchState,
  MinerState,
  ResourceNode,
  Unit,
  boardState,
  getTerrainAt,
  setTerrainAt,
} from "./state.js";
import { newCorrelationId, traceDecision, traceStateChange, traceWrite } from "./trace.js";
import { trackMiningDeposit } from "./phase2Trace.js";
import { Reason, State } from "./traceIds.js";
import { playSfx } from "./sfx.js";

export class MiningSystem extends createSystem({
  miners: { required: [Unit, MinerState] },
  resources: { required: [ResourceNode] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
}) {
  private readonly cycle: MiningCycleState = {
    stage: "idle",
    timer: 0,
    cargo: 0,
    nodeRemaining: 0,
    amountPerTrip: DEFAULT_RESOURCE_AMOUNT_PER_TRIP,
    gatherDuration: MINING_GATHER_TIME_SECONDS,
    crystals: 0,
  };

  update(delta: number): void {
    // Held at both ends of the match.
    //
    // Before the start: a miner working through the landing page grows the
    // treasury in proportion to how long the player read it — the same "the
    // game plays itself" defect the start gate exists to close, in the economy
    // rather than the waves.
    //
    // After it: crystals arriving during a defeat screen change a total the
    // player is still looking at.
    if (!matchAcceptsCommands("mining")) return;
    for (const miner of this.queries.miners.entities) {
      const stage = (miner.getValue(MinerState, "stage") ?? "idle") as MiningStage;
      if (stage === "idle") continue;

      const node = miner.getValue(MinerState, "target") as Entity | null;
      const gameState = boardState.gameState;
      if (!node || !gameState) {
        this.stopMining(miner, true);
        continue;
      }
      const baseAvailable = this.hasCommandCenterDeposit();
      if (!baseAvailable) {
        this.stopMining(miner, true);
        continue;
      }

      this.cycle.stage = stage;
      this.cycle.timer = miner.getValue(MinerState, "timer") ?? 0;
      this.cycle.cargo = miner.getValue(MinerState, "cargo") ?? 0;
      this.cycle.nodeRemaining = node.getValue(ResourceNode, "remaining") ?? 0;
      this.cycle.amountPerTrip =
        node.getValue(ResourceNode, "amountPerTrip") ??
        DEFAULT_RESOURCE_AMOUNT_PER_TRIP;
      this.cycle.crystals = gameState.getValue(GameState, "crystals") ?? 0;
      this.cycle.gatherDuration =
        boardState.debugSettings?.getValue(
          DebugSettings,
          "miningGatherTimeSeconds",
        ) ?? MINING_GATHER_TIME_SECONDS;

      const previousRemaining = this.cycle.nodeRemaining;
      const previousCrystals = this.cycle.crystals;
      const previousCargo = this.cycle.cargo;
      const transition = advanceMiningCycle(
        this.cycle,
        delta,
        !(miner.getValue(Unit, "hasOrder") ?? false),
        baseAvailable,
      );

      miner.setValue(MinerState, "stage", this.cycle.stage);
      miner.setValue(MinerState, "timer", this.cycle.timer);
      miner.setValue(MinerState, "cargo", this.cycle.cargo);

      if (this.cycle.cargo !== previousCargo) {
        traceStateChange(
          State.MinerCargo,
          previousCargo,
          this.cycle.cargo,
          transition === "loadedCargo" ? Reason.Accepted : Reason.Deposited,
        );
        // The two halves of a round trip. Hooked to the cargo CHANGE rather than
        // the stage: a miner sitting in a stage does not re-report, and the same
        // branch the trace already trusts decides which half this is.
        playSfx(transition === "loadedCargo" ? "crystal" : "deposit");
      }

      if (this.cycle.nodeRemaining !== previousRemaining) {
        node.setValue(ResourceNode, "remaining", this.cycle.nodeRemaining);
        traceStateChange(
          State.NodeRemaining,
          previousRemaining,
          this.cycle.nodeRemaining,
          this.cycle.nodeRemaining === 0 ? Reason.ResourceExhausted : Reason.Accepted,
        );
        if (this.cycle.nodeRemaining === 0) this.exhaustNode(node);
      }
      if (this.cycle.crystals !== previousCrystals) {
        const deposited = Math.max(0, this.cycle.crystals - previousCrystals);
        const revision = (gameState.getValue(GameState, "revision") ?? 0) + 1;
        const corr = newCorrelationId();
        gameState.setValue(GameState, "crystals", this.cycle.crystals);
        gameState.setValue(GameState, "revision", revision);
        traceWrite(
          State.Crystals,
          previousCrystals,
          this.cycle.crystals,
          revision,
          corr,
        );
        traceDecision(Reason.Deposited, deposited, miner.index, corr);
        trackMiningDeposit(revision, corr);
        const stats = boardState.gameStats;
        if (stats && deposited > 0) {
          stats.setValue(
            GameStats,
            "crystalsMined",
            (stats.getValue(GameStats, "crystalsMined") ?? 0) + deposited,
          );
          stats.setValue(
            GameStats,
            "revision",
            (stats.getValue(GameStats, "revision") ?? 0) + 1,
          );
        }
      }

      if (transition === "loadedCargo") {
        this.setCargoVisible(miner, true);
        this.issueStoredOrder(miner, "depositX", "depositY");
      } else if (transition === "deposited") {
        this.setCargoVisible(miner, false);
        triggerCommandCenterDepositDoors(boardState.commandCenter);
        if (this.cycle.stage === "toResource") {
          this.issueStoredOrder(miner, "approachX", "approachY");
        } else {
          this.retargetMiner(miner);
        }
      } else if (transition === "resourceEmpty") {
        this.setCargoVisible(miner, false);
        this.retargetMiner(miner);
      } else if (transition === "baseUnavailable") {
        this.setCargoVisible(miner, false);
      }
    }
  }

  private hasCommandCenterDeposit(): boolean {
    const commandCenter = boardState.commandCenter;
    if (!commandCenter?.object3D) return false;
    return (
      boardState.waveSource?.getValue(MatchState, "commandCenterAlive") ?? true
    );
  }

  private retargetMiner(miner: Entity): void {
    const object = miner.object3D;
    if (!object) {
      this.stopMining(miner);
      return;
    }
    const [fromX, fromY] = worldToGrid(object.position.x, object.position.z);
    const candidates = Array.from(this.queries.resources.entities, (resource) => ({
      target: resource,
      x: resource.getValue(ResourceNode, "x") ?? -1,
      y: resource.getValue(ResourceNode, "y") ?? -1,
      remaining: resource.getValue(ResourceNode, "remaining") ?? 0,
    }));
    const selection = selectNearestMiningTarget(
      { x: fromX, y: fromY },
      candidates,
      ({ x, y }) => this.findResourceApproach(miner, x, y),
    );
    if (!selection) {
      this.stopMining(miner);
      return;
    }

    miner.setValue(MinerState, "target", selection.target);
    miner.setValue(MinerState, "targetX", selection.x);
    miner.setValue(MinerState, "targetY", selection.y);
    miner.setValue(MinerState, "approachX", selection.approach.x);
    miner.setValue(MinerState, "approachY", selection.approach.y);
    miner.setValue(MinerState, "stage", "toResource");
    miner.setValue(MinerState, "timer", 0);
    this.issueOrder(miner, selection.approach.x, selection.approach.y);
  }

  private findResourceApproach(
    miner: Entity,
    targetX: number,
    targetY: number,
  ): MiningGridPosition | null {
    const object = miner.object3D;
    if (!object) return null;
    const [fromX, fromY] = worldToGrid(object.position.x, object.position.z);
    return findApproachTile({
      target: { x: targetX, y: targetY },
      from: { x: fromX, y: fromY },
      gridSize: GRID_SIZE,
      canStandAt: (x, y) => {
        return (
          getTerrainAt(x, y) === "open" &&
          !this.isOccupied(x, y, miner)
        );
      },
    });
  }

  private isOccupied(x: number, y: number, exclude: Entity): boolean {
    for (const unit of this.queries.units.entities) {
      if (unit === exclude || !unit.object3D) continue;
      const [unitX, unitY] = worldToGrid(
        unit.object3D.position.x,
        unit.object3D.position.z,
      );
      if (unitX === x && unitY === y) return true;
    }
    for (const enemy of this.queries.enemies.entities) {
      if (!enemy.object3D) continue;
      const [enemyX, enemyY] = worldToGrid(
        enemy.object3D.position.x,
        enemy.object3D.position.z,
      );
      if (enemyX === x && enemyY === y) return true;
    }
    return false;
  }

  private stopMining(miner: Entity, clearCargo = false): void {
    miner.setValue(MinerState, "stage", "idle");
    miner.setValue(MinerState, "timer", 0);
    if (clearCargo) {
      miner.setValue(MinerState, "cargo", 0);
      this.setCargoVisible(miner, false);
    }
    miner.setValue(MinerState, "target", null);
    miner.setValue(MinerState, "targetX", -1);
    miner.setValue(MinerState, "targetY", -1);
    miner.setValue(MinerState, "approachX", -1);
    miner.setValue(MinerState, "approachY", -1);
    miner.setValue(MinerState, "depositX", -1);
    miner.setValue(MinerState, "depositY", -1);
    miner.setValue(Unit, "hasOrder", false);
  }

  private issueOrder(miner: Entity, x: number, y: number): void {
    miner.setValue(Unit, "orderX", x);
    miner.setValue(Unit, "orderY", y);
    miner.setValue(Unit, "hasOrder", true);
  }

  private issueStoredOrder(
    miner: Entity,
    xField: "approachX" | "depositX",
    yField: "approachY" | "depositY",
  ): void {
    this.issueOrder(
      miner,
      miner.getValue(MinerState, xField) ?? -1,
      miner.getValue(MinerState, yField) ?? -1,
    );
  }

  private setCargoVisible(miner: Entity, visible: boolean): void {
    const cargo = boardState.cargoVisualByUnit.get(miner.index);
    if (cargo) cargo.visible = visible;
  }

  private exhaustNode(node: Entity): void {
    if (node.object3D) node.object3D.visible = false;
    const x = node.getValue(ResourceNode, "x") ?? -1;
    const y = node.getValue(ResourceNode, "y") ?? -1;
    setTerrainAt(x, y, "open");
  }
}
