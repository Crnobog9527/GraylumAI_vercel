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

/** What kind of paid step is about to start. `benchmark` is a mentor turn with a paid research tool call (the search and fetch). */
export type PaidStep = 'chat' | 'mentor' | 'report' | 'compare' | 'benchmark';

/**
 * The floor of each step's pre-check bound (controller 2026-11-03, option B): used alone when there is no history. A benchmark step is
 * 0.6, more than a whole day, so it never shares a day with another journey (one fetch cost $0.45 on 2026-11-03).
 */
export const STEP_FLOOR_USD: Readonly<Record<PaidStep, number>> = { chat: 0.05, mentor: 0.05, report: 0.05, compare: 0.05, benchmark: 0.6 };

/** The largest actual cost of one turn of this kind in the last 30 days (null with no history). */
export type StepCostReader = (step: PaidStep) => Promise<number | null>;

/**
 * Reads the per-turn cost history of the test accounts from the turn ledger: the sum of each turn's calls (actual, else nominal).
 * `mentor` counts only turns without a paid tool call; those are `benchmark`.
 */
export function dbStepCostReader(sql: Sql, actorIds: readonly string[]): StepCostReader {
  if (actorIds.length === 0) throw new Error('No billing account is known; a cost history of nothing would be a guess.');
  return async step => {
    const kind = step === 'benchmark' ? 'mentor' : step;
    const tools = step === 'mentor' ? 'without' : step === 'benchmark' ? 'with' : 'any';
    const rows = await sql<Array<{ usd: string | null }>>`
      select max(per_turn)::text as usd from (
        select sum(coalesce(c.actual_usd, c.nominal_usd, 0)) as per_turn,
          bool_or(c.call_kind = 'tool' and coalesce(c.actual_usd, c.nominal_usd, 0) > 0) as paid_tool
        from turns t join turn_calls c on c.actor_id = t.actor_id and c.turn_id = t.id
        where t.actor_id = any(${actorIds as string[]}::uuid[]) and t.kind = ${kind}
          and c.dispatched_at >= now() - interval '30 days'
        group by t.actor_id, t.id) per
      where case ${tools} when 'without' then not per.paid_tool when 'with' then per.paid_tool else true end`;
    const usd = rows[0]?.usd;
    return usd === null || usd === undefined ? null : Number(usd);
  };
}

/**
 * The pre-check bound of a paid step (controller 2026-11-03, options A with B as the floor): twice the largest actual cost of that
 * kind in the last 30 days, never below the step's floor. A test-side soft limit, not a guarantee: one turn can still cost more.
 */
export async function stepBoundUsd(step: PaidStep, history: StepCostReader): Promise<number> {
  const largest = await history(step);
  return Math.max(STEP_FLOOR_USD[step], largest === null ? 0 : largest * 2);
}

export class SpendMeter {
  private state: SpendState | undefined;
  /** The cost history the pre-check reads (set by the fixture); without it each step's floor is its bound. */
  history: StepCostReader | undefined;

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
   * Called before every paid step is sent: refuses it unless the day's spend plus the step's bound stays within the cap. A refusal
   * stops the run the same way passing the cap does, so nothing paid is sent after it.
   */
  async precheck(step: PaidStep, label: string): Promise<void> {
    const bound = this.history ? await stepBoundUsd(step, this.history) : STEP_FLOOR_USD[step];
    const spent = await this.read();
    if (spent + bound > this.capUsd) await this.exceed(`${label} (not sent: $${spent.toFixed(4)} spent + $${bound.toFixed(4)} bound)`, spent);
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
