/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const connectionString = process.env.V3_LOCAL_DB;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:')
  || !connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const tests = new URL('../../../../db/tests/', import.meta.url);
beforeAll(async () => {
  await db.connect();
  await db.query(await readFile(new URL('erasure-b2a/fixture.sql', tests), 'utf8'));
});
afterAll(async () => { await db.end(); });
it.each(['bill2.v1', 'bill2.v2'])('RUNTIME: %s user stop remains visible until saved or cancelled', async version => {
  const { stopViewCase } = await import(new URL('native-stop-view/cases.mjs', tests).href);
  await stopViewCase(db, version);
});
