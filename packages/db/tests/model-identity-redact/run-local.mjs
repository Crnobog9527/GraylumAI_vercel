/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only MODEL-IDENTITY-GUARD 0217 verification: signed-in clients cannot read
// model names through ai_models or token_stats (aliased).
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
  // Live rows go through every trigger.
  const conv = async owner => (await c.query("INSERT INTO conversations(user_id,title) VALUES($1,'t') RETURNING id", [owner])).rows[0].id;
  await c.query(`INSERT INTO token_stats(user_id,conversation_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata)
    VALUES($1,$3,'anthropic/claude-test',1,2,3,0,'{"pricing":{"model":"anthropic/claude-test"}}'),
          ($2,$4,'anthropic/claude-test',4,5,6,0,'{}')`, [user, other, await conv(user), await conv(other)]);

  for (const column of ['id', 'name', 'model_id', 'provider', 'config', 'description', 'input_token_cost']) {
    assert.equal(await v(`SELECT has_column_privilege('authenticated','public.ai_models',$1,'SELECT') v`, [column]), false, column);
    assert.equal(await v(`SELECT has_column_privilege('anon','public.ai_models',$1,'SELECT') v`, [column]), false, column);
  }
  await denied(user, 'SELECT name FROM ai_models');
  await denied(user, 'SELECT id FROM ai_models');
  report.checks.push('deny: signed-in and anonymous clients read no ai_models column');
  assert.equal((await c.query('SELECT name FROM ai_models WHERE id=$1', [model])).rows[0].name, 'Claude Test');

  const alias = /^m_[0-9a-f]{16}$/;
  const mine = async () => (await c.query('SELECT model_used,metadata FROM token_stats WHERE user_id=$1', [user])).rows[0];
  const stored = await mine();
  assert.match(stored.model_used, alias);
  assert.match(stored.metadata.pricing.model, alias, 'any model-named field is aliased');
  const own = await asUser(user, 'SELECT model_used,metadata,input_tokens,total_credits FROM token_stats');
  assert.equal(own.length, 1, 'RLS still limits a client to its own rows');
  assert.match(own[0].model_used, alias);
  assert.doesNotMatch(JSON.stringify(own[0].model_used), /claude|anthropic/i);
  await denied(user, 'SELECT model FROM model_usage_aliases');
  assert.equal(await v("SELECT has_table_privilege('authenticated','model_usage_aliases','SELECT') v"), false);
  report.checks.push('writes store an opaque alias; the client reads only the alias; the alias map is server-only');

  await c.query(`INSERT INTO token_stats(user_id,conversation_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata)
    VALUES($1,$2,'anthropic/claude-test',7,7,7,0,
    '{"modelId":"google/gemini-x","pricing":{"modelId":"anthropic/claude-test","providerModel":"google/gemini-x","inputPer1M":1}}')`,
    [other, await conv(other)]);
  const meta = (await c.query("SELECT model_used,metadata FROM token_stats WHERE user_id=$1 AND input_tokens=7", [other])).rows[0];
  assert.equal(meta.model_used, stored.model_used, 'one model has one alias');
  for (const value of [meta.metadata.modelId, meta.metadata.pricing.modelId, meta.metadata.pricing.providerModel]) assert.match(value, alias);
  assert.equal(meta.metadata.pricing.inputPer1M, 1);
  report.checks.push('metadata modelId / pricing.modelId / pricing.providerModel are aliased on insert, prices kept');

  // Review P1: the complete client-visible row, shaped like a legacy chat row, names no vendor.
  // Model brands and families; the route service name may remain as a key (openRouterCost).
  const VENDOR = /claude|anthropic|openai|gpt|gemini|google|deepmind|qwen|deepseek|llama|mistral|grok|通义|豆包/i;
  const legacyMeta = {
    skillId: 'skill-1', count_method: 'gemini_count_tokens', count_source: 'provider_usage',
    preflight_count_source: 'anthropic_count_tokens', counter_version: '2026-03-10',
    provider_usage: { source: 'provider_usage', providerResponseId: 'gen-1', openRouterCost: { totalUsd: 0.0012 }, inputTokens: 10 },
    routing_decision: { taskType: 'chat', modelRole: 'primary', reasonCodes: ['gemini_long_context'] },
    pricing: { modelId: 'google/gemini-2.5-flash', inputPer1M: 0.3, pricingSource: 'openrouter_catalog' },
    tokenizer: 'claude', search_evidence: { results: [{ url: 'https://www.google.com/search?q=x' }] },
  };
  await c.query(`INSERT INTO token_stats(user_id,conversation_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata)
    VALUES($1,$2,'google/gemini-2.5-flash',11,11,11,0,$3)`, [user, await conv(user), legacyMeta]);
  const visible = await asUser(user, 'SELECT * FROM token_stats WHERE input_tokens=11');
  const { search_evidence: evidence, ...rest } = visible[0].metadata;
  assert.doesNotMatch(JSON.stringify({ ...visible[0], metadata: rest }), VENDOR, JSON.stringify(visible[0]));
  assert.deepEqual(evidence, legacyMeta.search_evidence, 'public search provenance is kept as shown to the user');
  assert.equal(visible[0].metadata.provider_usage.inputTokens, 10);
  assert.equal(visible[0].metadata.provider_usage.openRouterCost.totalUsd, 0.0012, 'cost evidence keeps its listed key');
  assert.match(visible[0].metadata.pricing.pricingSource, alias, 'a route-naming value is aliased');
  assert.equal(visible[0].metadata.pricing.inputPer1M, 0.3);
  assert.equal(visible[0].metadata.counter_version, '2026-03-10');
  assert.equal(visible[0].metadata.preflight_count_source, 'provider_usage', 'erasure-listed counter label stays a listed value');
  const stored11 = (await c.query('SELECT metadata FROM token_stats WHERE input_tokens=11')).rows[0].metadata;
  // count_method's erasure list (official/estimate) already rejects legacy vendor values before 0217;
  // the counter-source fields 0217 normalises must still pass the erasure projection.
  const { count_method: _legacyMethod, ...erasable } = stored11;
  await c.query('SELECT erasure_ledger_metadata($1) v', [erasable]);
  report.checks.push('complete client-visible legacy row: every vendor-naming value aliased, keys, numbers and search evidence kept; erasure projection still accepts it');

  // Backfill: rows written before 0217 (trigger bypassed), including an erased ledger row.
  await c.query("SET session_replication_role='replica'");
  await c.query(`INSERT INTO token_stats(user_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata,
    content_erased_at,erased_conversation_id) VALUES($1,'openai/gpt-legacy',9,9,9,0,'{"pricing":{"modelId":"openai/gpt-legacy"}}',
    now(),gen_random_uuid())`, [user]);
  await c.query(`INSERT INTO token_stats(user_id,model_used,input_tokens,output_tokens,total_credits,total_cost_usd,metadata,
    content_erased_at,erased_conversation_id) VALUES($1,'bill2.aggregate',12,12,12,0,$2,now(),gen_random_uuid())`,
    [user, { runId: '10000000-0000-4000-8000-0000000000aa', count_source: 'gemini_count_tokens' }]);
  await c.query("SET session_replication_role='origin'");
  await c.query(read(migrationPath));
  const ledger = (await c.query('SELECT metadata FROM token_stats WHERE input_tokens=12')).rows[0].metadata;
  assert.equal(ledger.runId, '10000000-0000-4000-8000-0000000000aa', 'erasure ledger evidence keys are untouched');
  assert.equal(ledger.count_source, 'provider_usage');
  assert.doesNotMatch(JSON.stringify(ledger), VENDOR);
  const legacy = (await c.query('SELECT model_used,metadata FROM token_stats WHERE input_tokens=9')).rows[0];
  assert.match(legacy.model_used, alias);
  assert.equal(legacy.metadata.pricing.modelId, legacy.model_used);
  const before2 = JSON.stringify((await c.query('SELECT id,model_used,metadata FROM token_stats ORDER BY id')).rows);
  await c.query(read(migrationPath));
  assert.equal(JSON.stringify((await c.query('SELECT id,model_used,metadata FROM token_stats ORDER BY id')).rows), before2);
  report.checks.push('backfill aliases pre-0217 rows (erased ledger rows too); running 0217 again changes no data');

  await c.query('SET ROLE service_role');
  const map = (await c.query('SELECT alias,model FROM model_usage_aliases WHERE alias=$1', [legacy.model_used])).rows[0];
  assert.equal(map.model, 'openai/gpt-legacy');
  await c.query('RESET ROLE');
  report.checks.push('service_role resolves an alias back to the real model for admin reports');

  await c.query(read('packages/db/tests/model-identity-redact/rollback.sql'));
  const restored = (await c.query('SELECT model_used,metadata FROM token_stats WHERE input_tokens=7')).rows[0];
  assert.equal(restored.model_used, 'anthropic/claude-test');
  assert.equal(restored.metadata.pricing.providerModel, 'google/gemini-x');
  assert.equal(restored.metadata.modelId, 'google/gemini-x');
  // Review P1: recovery walks the whole JSON; only the two documented counter labels stay normalised.
  const restored11 = (await c.query('SELECT model_used,metadata FROM token_stats WHERE input_tokens=11')).rows[0];
  assert.equal(restored11.model_used, 'google/gemini-2.5-flash');
  assert.deepEqual(restored11.metadata, { ...legacyMeta, count_source: 'provider_usage', preflight_count_source: 'provider_usage' });
  assert.doesNotMatch(JSON.stringify((await c.query('SELECT metadata FROM token_stats')).rows), /"m_[0-9a-f]{16}"/);
  await c.query(read(migrationPath));
  assert.match((await c.query('SELECT model_used FROM token_stats WHERE input_tokens=7')).rows[0].model_used, alias);
  report.checks.push('rollback restores every aliased value at any depth (only the two documented counter labels stay normalised); re-applying 0217 aliases them again');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
