import { Entity, createSystem } from "@iwsdk/core";
import { advanceMiningCycle } from "./miningRules.js";
import type { MiningCycleState, MiningStage } from "./miningRules.js";
import {
  BoardTile,
  GameState,
  GameStats,
  MinerState,
  ResourceNode,
  Unit,
  boardState,
  gridKey,
} from "./state.js";

export class MiningSystem extends createSystem({
  miners: { required: [Unit, MinerState] },
}) {
  private readonly cycle: MiningCycleState = {
    stage: "idle",
    timer: 0,
    cargo: 0,
    nodeRemaining: 0,
    amountPerTrip: 10,
    crystals: 0,
  };

  update(delta: number): void {
    for (const miner of this.queries.miners.entities) {
      const stage = (miner.getValue(MinerState, "stage") ?? "idle") as MiningStage;
      if (stage === "idle") continue;

      const node = miner.getValue(MinerState, "target") as Entity | null;
      const gameState = boardState.gameState;
      if (!node || !gameState) {
        miner.setValue(MinerState, "stage", "idle");
        continue;
      }

      this.cycle.stage = stage;
      this.cycle.timer = miner.getValue(MinerState, "timer") ?? 0;
      this.cycle.cargo = miner.getValue(MinerState, "cargo") ?? 0;
      this.cycle.nodeRemaining = node.getValue(ResourceNode, "remaining") ?? 0;
      this.cycle.amountPerTrip = node.getValue(ResourceNode, "amountPerTrip") ?? 10;
      this.cycle.crystals = gameState.getValue(GameState, "crystals") ?? 0;

      const previousRemaining = this.cycle.nodeRemaining;
      const previousCrystals = this.cycle.crystals;
      const transition = advanceMiningCycle(
        this.cycle,
        delta,
        !(miner.getValue(Unit, "hasOrder") ?? false),
      );

      miner.setValue(MinerState, "stage", this.cycle.stage);
      miner.setValue(MinerState, "timer", this.cycle.timer);
      miner.setValue(MinerState, "cargo", this.cycle.cargo);

      if (this.cycle.nodeRemaining !== previousRemaining) {
        node.setValue(ResourceNode, "remaining", this.cycle.nodeRemaining);
        if (this.cycle.nodeRemaining === 0) this.exhaustNode(node);
      }
      if (this.cycle.crystals !== previousCrystals) {
        const deposited = Math.max(0, this.cycle.crystals - previousCrystals);
        gameState.setValue(GameState, "crystals", this.cycle.crystals);
        gameState.setValue(
          GameState,
          "revision",
          (gameState.getValue(GameState, "revision") ?? 0) + 1,
        );
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
        if (this.cycle.stage === "toResource") {
          this.issueStoredOrder(miner, "approachX", "approachY");
        }
      } else if (transition === "resourceEmpty") {
        this.setCargoVisible(miner, false);
      }
    }
  }

  private issueStoredOrder(
    miner: Entity,
    xField: "approachX" | "depositX",
    yField: "approachY" | "depositY",
  ): void {
    miner.setValue(Unit, "orderX", miner.getValue(MinerState, xField) ?? -1);
    miner.setValue(Unit, "orderY", miner.getValue(MinerState, yField) ?? -1);
    miner.setValue(Unit, "hasOrder", true);
  }

  private setCargoVisible(miner: Entity, visible: boolean): void {
    const cargo = boardState.cargoVisualByUnit.get(miner.index);
    if (cargo) cargo.visible = visible;
  }

  private exhaustNode(node: Entity): void {
    if (node.object3D) node.object3D.visible = false;
    const x = node.getValue(ResourceNode, "x") ?? -1;
    const y = node.getValue(ResourceNode, "y") ?? -1;
    boardState.tileByKey.get(gridKey(x, y))?.setValue(BoardTile, "terrain", "open");
  }
}
