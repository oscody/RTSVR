/**
 * Small, event-driven correlation tables for Phase 2 gameplay handoffs.
 *
 * These are deliberately not ECS state and are only touched at deposits and
 * placements. Keeping them here prevents UI, mining, construction and craft
 * systems from retaining one another's entities or inventing a polling loop.
 */

import { Consumer, expectHandoff, observeHandoff } from "./traceContracts.js";
import { Contract } from "./traceIds.js";
import { isTraceRecording } from "./traceRecorder.js";

const MAX_TRACKED = 64;
const depositCorrelationByRevision = new Map<number, number>();
const siteCorrelationByIndex = new Map<number, { contract: number; corr: number }>();

function bound<K, V>(table: Map<K, V>): void {
  if (table.size < MAX_TRACKED) return;
  const oldest = table.keys().next().value as K | undefined;
  if (oldest !== undefined) table.delete(oldest);
}

/** A MiningSystem deposit awaits the first TabletSystem economy read. */
export function trackMiningDeposit(revision: number, corr: number): void {
  if (!isTraceRecording()) return;
  bound(depositCorrelationByRevision);
  depositCorrelationByRevision.set(revision, corr);
  expectHandoff(Contract.MiningDepositReachesEconomy, corr, Consumer.TabletRead);
}

/** TabletSystem consumed the GameState revision published by a deposit. */
export function observeMiningEconomyRead(revision: number): void {
  if (!isTraceRecording()) return;
  const corr = depositCorrelationByRevision.get(revision);
  if (corr === undefined) return;
  observeHandoff(Contract.MiningDepositReachesEconomy, corr, Consumer.TabletRead);
  depositCorrelationByRevision.delete(revision);
}

/** A successful tablet-originated placement awaits its owning system. */
export function trackPlacedSite(
  entityIndex: number,
  contract: number,
  corr: number,
  consumer: number,
): void {
  if (!isTraceRecording()) return;
  bound(siteCorrelationByIndex);
  siteCorrelationByIndex.set(entityIndex, { contract, corr });
  expectHandoff(contract, corr, consumer);
}

/** ConstructionSystem or CraftProductionSystem picked up a placed site. */
export function observePlacedSite(entityIndex: number, consumer: number): void {
  if (!isTraceRecording()) return;
  const pending = siteCorrelationByIndex.get(entityIndex);
  if (!pending) return;
  observeHandoff(pending.contract, pending.corr, consumer);
  siteCorrelationByIndex.delete(entityIndex);
}

/** Scenario reset ends the old match's event correlations. */
export function clearPhase2Trace(): void {
  depositCorrelationByRevision.clear();
  siteCorrelationByIndex.clear();
}
