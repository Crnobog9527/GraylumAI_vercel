/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {ready,detach} from './cases.mjs';
export async function runConcurrency({db,Client,connectionString,report}) {
 const a=new Client({connectionString}),b=new Client({connectionString});
 await a.connect();await b.connect();
 try {
  const f=await ready(db);
  await a.query('BEGIN');await a.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[f.session]);
  assert.equal((await detach(b,f)).reason,'binding_busy');
  await a.query('COMMIT');
  const results=await Promise.all([detach(a,f),detach(b,f)]);
  assert.equal(results.filter(x=>x.processed===1).length,1);
  assert.deepEqual(await detach(db,f),{processed:0,remaining:0});
  report.checks.push('real two-connection busy-session retry and concurrent detach; no reverse lock wait');
 } finally {await a.query('ROLLBACK');await a.end();await b.end();}
}
