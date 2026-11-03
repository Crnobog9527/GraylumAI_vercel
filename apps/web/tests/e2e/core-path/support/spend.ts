/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';

import { resultsDirectory } from './config';

export class SpendCapExceeded extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number, readonly label: string) {
    super(`Core-path spend cap exceeded after "${label}": $${spentUsd.toFixed(4)} > $${capUsd.toFixed(2)}. The run stops here.`);
    this.name = 'SpendCapExceeded';
  }
}

export interface JourneySpend {
  label: string;
  /** The platform's actual provider cost of this journey (not the credits charged to the user). */
  usd: number;
  cumulativeUsd: number;
}

/** `baselineUsd`: what was already spent when this run began (daily mode counts the whole UTC day); this run spent total - baseline. */
interface SpendState { capUsd: number; totalUsd: number; exceeded: boolean; journeys: JourneySpend[]; lastSeenUsd?: number; baselineUsd?: number }

/** Where the running state lives: a file, so a restarted worker keeps the journeys and the "exceeded" flag. */
export interface SpendStore { load(): Promise<SpendState | null>; save(state: SpendState): Promise<void> }

export const fileSpendStore = (file = path.join(resultsDirectory, 'spend.json')): SpendStore => ({
  load: () => readFile(file, 'utf8').then(text => JSON.parse(text) as SpendState, () => null),
  save: async state => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(state, null, 2)); },
});

/** Reads the cumulative provider cost of the test accounts since the run started. */
export type SpendReader = () => Promise<number>;

/**
 * Sums bill2_runs.provider_cost_usd (falling back to the run's calls while it is not yet settled) for the dedicated test
 * accounts (by account id) since `sinceIso`. Credits are never used: the report is a fixed 500 credits whatever the model costs,
 * so credits cannot tell what a run cost the platform. With no account ids the reader refuses instead of reporting zero.
 */
export function dbSpendReader(sql: Sql, actorIds: readonly string[], sinceIso: string): SpendReader {
  if (actorIds.length === 0) throw new Error('No billing account is known; a spend of zero would be a guess.');
  return async () => {
    // The old path (bill2_runs) and the turn path (turn_calls, CORE-PATH-V2) are both read until V2-12 removes the old one.
    const rows = await sql<Array<{ usd: string | null }>>`
      select ((select coalesce(sum(coalesce(r.provider_cost_usd::numeric,
        (select sum(c.selected_cost_usd::numeric) from bill2_calls c where c.run_id = r.id), 0)), 0)
        from bill2_runs r
        where r.actor_id = any(${actorIds as string[]}::uuid[]) and r.created_at >= ${sinceIso}::timestamptz)
      + (select coalesce(sum(coalesce(t.actual_usd, t.nominal_usd, 0)), 0)
        from turn_calls t
        where t.actor_id = any(${actorIds as string[]}::uuid[]) and t.dispatched_at >= ${sinceIso}::timestamptz))::text as usd`;
    return Number(rows[0]?.usd ?? 0);
  };
}

export class SpendMeter {
  private state: SpendState | undefined;

  /**
   * With `countsEarlierSpend` (daily mode: the reader counts from the start of the UTC day) the first reading is what earlier runs
   * of the day spent: it is the run's baseline, so the first journey is not billed for them.
   */
  constructor(readonly capUsd: number, private readonly read: SpendReader,
    private readonly store: SpendStore = { load: async () => null, save: async () => undefined }, private readonly countsEarlierSpend = false) {}

  private async current(): Promise<SpendState> {
    if (this.state) return this.state;
    const stored = await this.store.load();
    if (stored) this.state = stored;
    else {
      const baseline = this.countsEarlierSpend ? await this.read() : 0;
      this.state = { capUsd: this.capUsd, totalUsd: baseline, baselineUsd: baseline, exceeded: false, journeys: [] };
      await this.store.save(this.state);
    }
    return this.state;
  }

  get journeys(): readonly JourneySpend[] { return this.state?.journeys ?? []; }
  get totalUsd() { return this.state?.totalUsd ?? 0; }
  /** What this run itself spent (the total minus what earlier runs of the day had spent). */
  get runUsd() { return (this.state?.totalUsd ?? 0) - (this.state?.baselineUsd ?? 0); }

  /**
   * How much of the cap is left right now. A journey whose usual cost does not fit is skipped instead of started: the hard stop
   * below only fires after a turn, so it cannot keep one costly turn from going past the cap.
   */
  async remainingUsd(): Promise<number> {
    await this.current();
    return this.capUsd - (await this.read());
  }

  /**
   * Called before a test starts: once the cap has been passed, no later test may make a paid call. The "exceeded" flag is
   * persisted, so it also holds after a worker restart.
   */
  async assertRoom(label: string): Promise<void> {
    const state = await this.current();
    if (state.exceeded) throw new SpendCapExceeded(state.totalUsd, this.capUsd, `${label} (cap already passed)`);
    const cumulative = await this.read();
    if (cumulative > this.capUsd) await this.exceed(label, cumulative);
  }

  /** Reads the cumulative cost and stops the run once the cap is passed. Call after every model turn. */
  async checkpoint(label: string): Promise<number> {
    const cumulative = await this.read();
    if (cumulative > this.capUsd) await this.exceed(label, cumulative);
    // Keep the latest reading on disk, so a journey that fails half way still leaves what it had spent.
    const state = await this.current();
    state.lastSeenUsd = cumulative;
    await this.store.save(state);
    return cumulative;
  }

  /** Closes a journey: records what it added to the running total. */
  async finishJourney(label: string): Promise<JourneySpend> {
    const cumulative = await this.read();
    const entry = await this.record(label, cumulative);
    if (cumulative > this.capUsd) await this.exceed(label, cumulative, false);
    return entry;
  }

  /** Books what is still unaccounted for to the test that was running, so a failed journey keeps its own cost. */
  async closeTest(label: string): Promise<void> {
    const state = await this.current();
    const cumulative = await this.read();
    if (cumulative - state.totalUsd > 0.00005) await this.record(`${label} (unclosed)`, cumulative);
  }

  private async exceed(label: string, cumulative: number, record = true): Promise<never> {
    const state = await this.current();
    if (record) await this.record(label, cumulative);
    state.exceeded = true;
    await this.store.save(state);
    throw new SpendCapExceeded(cumulative, this.capUsd, label);
  }

  private async record(label: string, cumulative: number): Promise<JourneySpend> {
    const state = await this.current();
    const entry = { label, usd: Math.max(0, cumulative - state.totalUsd), cumulativeUsd: cumulative };
    state.totalUsd = cumulative;
    state.journeys.push(entry);
    await this.store.save(state);
    return entry;
  }
}
