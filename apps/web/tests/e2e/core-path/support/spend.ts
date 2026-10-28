/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

/** Reads the cumulative provider cost of the test accounts since the run started. */
export type SpendReader = () => Promise<number>;

/**
 * Sums bill2_runs.provider_cost_usd (falling back to the run's calls while it is not yet settled) for the dedicated test
 * accounts since `sinceIso`. Credits are never used: the report is a fixed 500 credits whatever the model costs, so
 * credits cannot tell what a run cost the platform.
 */
export function dbSpendReader(sql: Sql, emails: readonly string[], sinceIso: string): SpendReader {
  return async () => {
    if (emails.length === 0) return 0;
    const rows = await sql<Array<{ usd: string | null }>>`
      select coalesce(sum(coalesce(r.provider_cost_usd::numeric,
        (select sum(c.selected_cost_usd::numeric) from bill2_calls c where c.run_id = r.id), 0)), 0)::text as usd
      from bill2_runs r join profiles p on p.id = r.actor_id
      where p.email = any(${emails as string[]}) and r.created_at >= ${sinceIso}::timestamptz`;
    return Number(rows[0]?.usd ?? 0);
  };
}

export class SpendMeter {
  readonly journeys: JourneySpend[] = [];
  private last = 0;

  constructor(readonly capUsd: number, private readonly read: SpendReader) {}

  /** Reads the cumulative cost and stops the run once the cap is passed. Call after every model turn. */
  async checkpoint(label: string): Promise<number> {
    const cumulative = await this.read();
    if (cumulative > this.capUsd) {
      this.record(label, cumulative);
      throw new SpendCapExceeded(cumulative, this.capUsd, label);
    }
    return cumulative;
  }

  /** Closes a journey: records what it added to the running total. */
  async finishJourney(label: string): Promise<JourneySpend> {
    const cumulative = await this.read();
    const entry = this.record(label, cumulative);
    if (cumulative > this.capUsd) throw new SpendCapExceeded(cumulative, this.capUsd, label);
    return entry;
  }

  get totalUsd() { return this.last; }

  private record(label: string, cumulative: number): JourneySpend {
    const entry = { label, usd: Math.max(0, cumulative - this.last), cumulativeUsd: cumulative };
    this.last = cumulative;
    this.journeys.push(entry);
    return entry;
  }

  async writeReport(file = path.join(resultsDirectory, 'spend.json')) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ capUsd: this.capUsd, totalUsd: this.last, journeys: this.journeys }, null, 2));
  }
}
