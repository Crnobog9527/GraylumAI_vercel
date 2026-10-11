/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only MODEL-IDENTITY-GUARD 0217 verification: signed-in clients cannot read
// model names through ai_models.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0217_model_identity_client_grants.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0217', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const asUser = async (sub, query) => {
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
    await c.query('SET LOCAL ROLE authenticated');
    return (await c.query(query)).rows;
  } finally { await c.query('ROLLBACK'); }
};
const denied = async (sub, query) => {
  const error = await asUser(sub, query).then(() => null, e => e);
  assert.equal(error?.code, '42501', `${query}: ${error?.message}`);
};
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0217 reapplication after the full chain preserves the complete catalog');

  const user = randomUUID(), other = randomUUID(), model = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0),($2,0)', [user, other]);
  await c.query(`INSERT INTO ai_models(id,model_id,name,provider,is_active,max_tokens,input_limit)
    VALUES($1,'anthropic/claude-test','Claude Test','anthropic','true',1024,1024)`, [model]);
  // Fixture rows only: skip usage-lifecycle triggers; table CHECK constraints still apply.
  await c.query("SET session_replication_role='replica'");
  await c.query(`INSERT INTO token_stats(user_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata,
    content_erased_at,erased_conversation_id)
    VALUES($1,'anthropic/claude-test',1,2,3,0,'{"pricing":{"model":"anthropic/claude-test"}}',now(),gen_random_uuid()),
          ($2,'anthropic/claude-test',4,5,6,0,'{}',now(),gen_random_uuid())`, [user, other]);
  await c.query("SET session_replication_role='origin'");

  for (const column of ['id', 'name', 'model_id', 'provider', 'config', 'description', 'input_token_cost']) {
    assert.equal(await v(`SELECT has_column_privilege('authenticated','public.ai_models',$1,'SELECT') v`, [column]), false, column);
    assert.equal(await v(`SELECT has_column_privilege('anon','public.ai_models',$1,'SELECT') v`, [column]), false, column);
  }
  await denied(user, 'SELECT name FROM ai_models');
  await denied(user, 'SELECT id FROM ai_models');
  report.checks.push('deny: signed-in and anonymous clients read no ai_models column');

  // Not narrowed by 0217 (0148 convergence grants table-level SELECT); recorded so a change is noticed.
  const own = await asUser(user, 'SELECT input_tokens,output_tokens,total_credits FROM token_stats');
  assert.deepEqual(own.map(r => [r.input_tokens, r.output_tokens, Number(r.total_credits)]), [[1, 2, 3]]);
  report.checks.push('token_stats unchanged: own rows readable, other users filtered by RLS (model_used narrowing deferred)');

  await c.query('SET ROLE service_role');
  assert.equal((await c.query('SELECT name FROM ai_models WHERE id=$1', [model])).rows[0].name, 'Claude Test');
  assert.equal((await c.query('SELECT model_used FROM token_stats WHERE user_id=$1', [user])).rows[0].model_used, 'anthropic/claude-test');
  await c.query('RESET ROLE');
  report.checks.push('service_role server reads are unchanged');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
