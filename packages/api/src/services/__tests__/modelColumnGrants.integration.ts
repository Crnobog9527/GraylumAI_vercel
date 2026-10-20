/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import pg from 'pg';

it('OR-2: the ai_models credential column is absent after migration', async () => {
  const connectionString = process.env.V3_LOCAL_DB!;
  if (!connectionString?.endsWith('/v3_disposable')) throw new Error('Local disposable database required');
  const sql = new pg.Client({ connectionString });
  try {
    await sql.connect();
    const result = await sql.query<{ present: boolean }>(`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_models' and column_name = 'api_key'
      ) as present
    `);
    expect(result.rows[0]?.present).toBe(false);
  } finally {
    await sql.end();
  }
}, 180000);
