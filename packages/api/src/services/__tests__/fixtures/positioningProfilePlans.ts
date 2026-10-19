/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

/** Seed the membership-plan rows required by OPC integration fixtures. */
export async function ensurePositioningProfilePlans(sql: Pick<Client, 'query'>) {
  for (const [level, limit, bytes, days] of [
    ['free', 1, 50_000_000, 0],
    ['pro', 3, 500_000_000, 30],
    ['gold', 6, 2_000_000_000, 90],
  ] as const) {
    const paid = level !== 'free';
    const gold = level === 'gold';
    await sql.query(
      `insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
        allow_publish,own_data_window_days,allow_benchmark_monitor,allow_weekly_auto_review,positioning_profile_limit)
       values($1,$2,$2,$3,$3,$4,$3,$5,$6,$6,$7)
       on conflict(level) do update set positioning_profile_limit=excluded.positioning_profile_limit`,
      [randomUUID(), level, paid, bytes, days, gold, limit],
    );
  }
}
