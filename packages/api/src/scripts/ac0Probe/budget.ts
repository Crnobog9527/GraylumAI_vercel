/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** Owner decision 2026-09-28: the whole AC-0 feasibility measurement may not
 * exceed 200 provider calls or 3 USD. No flag can raise these. */
export const HARD_MAX_CALLS = 200;
export const HARD_MAX_USD = 3;
export const DEFAULT_MAX_CALLS = 60;
export const DEFAULT_MAX_USD = 1;

const NANO = 1_000_000_000;
export const usdToNano = (usd: number): number => Math.ceil(usd * NANO);
export const nanoToUsd = (nano: number): number => Math.round(nano) / NANO;

export type LedgerTotals = {calls: number; nanoUsd: number};
export type LedgerStore = {read(): LedgerTotals; write(totals: LedgerTotals): void};

export class BudgetStop extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('PROBE_BUDGET_STOP:' + reason);
    this.reason = reason;
  }
}

export function validateCaps(maxCalls: number, maxUsd: number): void {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_MAX_CALLS) {
    throw new Error(`PROBE_CAP_REFUSED: --max-calls must be an integer from 1 to ${HARD_MAX_CALLS}`);
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > HARD_MAX_USD) {
    throw new Error(`PROBE_CAP_REFUSED: --max-usd must be above 0 and at most ${HARD_MAX_USD}`);
  }
}

export function memoryLedger(initial: LedgerTotals = {calls: 0, nanoUsd: 0}): LedgerStore {
  let totals = {...initial};
  return {read: () => ({...totals}), write: next => { totals = {...next}; }};
}

/** Cumulative totals across live runs, stored outside the repository. Each call
 * is written as a reservation before it is sent, so a crash cannot hide spend. */
export function fileLedger(path: string): LedgerStore {
  return {
    read() {
      if (!existsSync(path)) return {calls: 0, nanoUsd: 0};
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerTotals>;
      const calls = Number(parsed.calls);
      const nanoUsd = Number(parsed.nanoUsd);
      if (!Number.isSafeInteger(calls) || calls < 0 || !Number.isSafeInteger(nanoUsd) || nanoUsd < 0) {
        throw new Error('PROBE_LEDGER_INVALID: fix or remove ' + path);
      }
      return {calls, nanoUsd};
    },
    write(totals) {
      mkdirSync(dirname(path), {recursive: true});
      const temporary = path + '.tmp';
      const usd = nanoToUsd(totals.nanoUsd);
      writeFileSync(temporary, JSON.stringify({...totals, usd, updatedAt: new Date().toISOString()}, null, 2) + '\n');
      renameSync(temporary, path);
    },
  };
}

export type Settle = (actualNano: number) => void;

/** Per-run and cumulative call/spend limits. reserve() must succeed before any
 * request leaves the process; settle() replaces the reservation with the cost. */
export function createBudget(options: {maxCalls: number; maxUsd: number; ledger: LedgerStore}) {
  validateCaps(options.maxCalls, options.maxUsd);
  const maxNano = usdToNano(options.maxUsd);
  const hardNano = usdToNano(HARD_MAX_USD);
  const run = {calls: 0, nanoUsd: 0};
  let stopped: string | null = null;

  function reserve(boundNano: number): Settle {
    if (!Number.isSafeInteger(boundNano) || boundNano <= 0) throw new Error('PROBE_BOUND_INVALID');
    if (stopped) throw new BudgetStop(stopped);
    const total = options.ledger.read();
    if (run.calls + 1 > options.maxCalls) stopped = 'run_call_cap';
    else if (run.nanoUsd + boundNano > maxNano) stopped = 'run_usd_cap';
    else if (total.calls + 1 > HARD_MAX_CALLS) stopped = 'total_call_cap';
    else if (total.nanoUsd + boundNano > hardNano) stopped = 'total_usd_cap';
    if (stopped) throw new BudgetStop(stopped);
    run.calls += 1;
    run.nanoUsd += boundNano;
    options.ledger.write({calls: total.calls + 1, nanoUsd: total.nanoUsd + boundNano});
    let settled = false;
    return actualNano => {
      if (settled) throw new Error('PROBE_SETTLE_TWICE');
      settled = true;
      const actual = Math.max(0, Math.ceil(actualNano));
      run.nanoUsd += actual - boundNano;
      const current = options.ledger.read();
      options.ledger.write({calls: current.calls, nanoUsd: Math.max(0, current.nanoUsd + actual - boundNano)});
    };
  }

  return {
    reserve,
    get run() { return {...run}; },
    get stopped() { return stopped; },
    stop(reason: string) { stopped ??= reason; },
  };
}
export type Budget = ReturnType<typeof createBudget>;
