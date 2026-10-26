/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// REL-1: one disposable PostgreSQL 17 build, no URLs/env files/remote services. Automatically discovered by CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const mode = process.argv[2];
assert.ok(mode === '--ci' ? process.env.CI : mode === '--local-only' && !process.env.CI);
const read = path => readFileSync(resolve(root, path), 'utf8');
const seed = read('packages/db/seeds/production_non_secret_baseline.sql');
const block = /\$build_day\$[\s\S]*?\$build_day\$/;
const required = JSON.parse(seed.match(block)[0].slice('$build_day$'.length, -'$build_day$'.length));
assert.equal(Object.keys(required).length, 7);
assert.ok(Object.values(required).every(value => value === null || typeof value === 'object'));
const ids = ['11','12','13','14','15','16'].map(tail => `90000000-0000-4000-8000-0000000000${tail}`);
const models = ['anthropic/claude-sonnet-5.5','google/gemini-3.8-flash','openai/gpt-6.1-sol',
  'anthropic/claude-opus-5.5','google/gemini-4-argon','openai/gpt-6-luna'];
const skill = '90000000-0000-4000-8000-000000000020';
// Synthetic values test placeholder mechanics, NOT frozen release budgets or paid project quota.
const filled = {
  runtime_purpose_budgets: JSON.stringify({ version: 2, interactive: { inputBytes: 90000, historyItems: 100 },
    organize: { inputBytes: 112000, historyItems: 100 }, report: { inputBytes: 196608, historyItems: 100 } }),
  billing_payg_start_thresholds: { version: 'local-synthetic', thresholds: models.map(model => ({ model,
    purpose: 'skill', typicalUsd: '0.01' })) },
  fusion_settings: { version: 1, compare: { enabled: true, allowedModelIds: ids.slice(0,4),
    defaultModelIds: ids.slice(0,3), minModels: 2, answerOutputTokens: 8192, maxBudgetUsd: '5',
    dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } },
  review: { enabled: true, reviewerModelIds: [ids[0],ids[2],ids[4]], summaryModelId: ids[3], skillId: skill,
    maxRounds: 1, opinionOutputTokens: 4096, summaryOutputTokens: 32768, maxBudgetUsd: '5',
    fixedPriceCredits: 1500, dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 },
    displayNames: { reviewers: ['评审 A','评审 B','评审 C'], summary: '汇总' }, reviewerRoles: { [ids[0]]: 'evidence', [ids[2]]: 'finance', [ids[4]]: 'execution' } } },
  primary_model_id: ids[0], v3_summary_model_id: ids[5], publish_monitor_review_model_id: ids[0],
  publish_monitor_publish_quota: { limit: 1000, periodAnchor: '2026-01-01T00:00:00Z' },
};
// Preserve every released non-null template value; successful tests only fill null slots.
function fillSlots(template, values) {
  if (template === null) return values;
  if (Array.isArray(template)) return template.map((value, i) => fillSlots(value, values?.[i]));
  if (typeof template === 'object') return Object.fromEntries(Object.entries(template)
    .map(([key, value]) => [key, fillSlots(value, values?.[key])]));
  return template;
}
assert.deepEqual(fillSlots(required, filled), filled, 'fixture must preserve the actual production template');
const sqlLiteral = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const rendered = values => seed.replace(block, () => `$build_day$${JSON.stringify(values)}$build_day$`);
const body = text => text.match(/DO \$production_seed\$[\s\S]*?\$production_seed\$;/)[0];
const fail = (text, error) => `DO $test$ BEGIN
  BEGIN EXECUTE $attempt$${body(text)}$attempt$;
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '${error}' THEN RAISE; END IF; RETURN; END;
  RAISE EXCEPTION 'seed unexpectedly accepted invalid input'; END $test$;`;
// Snapshot all three target tables, including IDs/timestamps. Failure/replay must preserve every byte.
const state = `SELECT jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM public.system_settings s),
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY level) FROM public.membership_plans p),
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.credit_packages p)) AS value`;
const unchanged = name => `DO $$ BEGIN IF (${state}) IS DISTINCT FROM (SELECT value FROM ${name})
  THEN RAISE EXCEPTION 'seed changed ${name}'; END IF; END $$;`;
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const objects = `${fingerprint.slice(0, fingerprint.indexOf('-- FINAL'))}SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped`;
const expected = {
  billing_credits_per_usd: '100', billing_token_price_multiplier: '6', runtime_report_generation: { enabled: true },
  chat_research_tools_enabled: true, library_agent_read_enabled: true, chat_library_retrieval_enabled: true,
  library_scan_recognition_enabled: true, library_upload_enabled: true, chat_my_posts_enabled: true,
  publish_monitor_enabled: true, publish_monitor_review_enabled: true, publish_monitor_review_max_usd: '0.30',
  publish_monitor_publish_platforms: ['tiktok','instagram','youtube','facebook','x','threads','linkedin','pinterest','bluesky'],
  ...filled,
};
const verify = `DO $$ DECLARE expected jsonb := ${sqlLiteral(expected)}; r record; BEGIN
  FOR r IN SELECT key,value FROM jsonb_each(expected) LOOP
    IF (SELECT value FROM system_settings WHERE key=r.key) IS DISTINCT FROM r.value THEN
      RAISE EXCEPTION 'value or JSON type differs: %',r.key; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM system_settings s FULL JOIN seed_settings_before b USING(key)
    WHERE NOT expected ? coalesce(s.key,b.key) AND s.value IS DISTINCT FROM b.value) THEN
    RAISE EXCEPTION 'unlisted setting was changed'; END IF;
  IF EXISTS (SELECT 1 FROM system_settings WHERE key LIKE 'checkin_%' OR key='runtime_payg_staging') THEN
    RAISE EXCEPTION 'deleted/staging-only settings imported'; END IF;
END $$;`;
const cases = [
  `CREATE TEMP TABLE seed_schema_before AS ${objects};`,
  `CREATE TEMP TABLE seed_empty_before AS ${state};`,
  // Historical migrations may seed diagnostic rows; this seed must neither add nor change identities.
  `CREATE TEMP TABLE seed_identities_before AS SELECT jsonb_agg(to_jsonb(p) ORDER BY id) AS value FROM profiles p;`,
  // On the genuinely empty file-built catalog, the committed template fails before all writes.
  fail(seed, 'PRODUCTION_SEED_REPLACE_REQUIRED: %'),
  unchanged('seed_empty_before'),
  // Wrong or absent B2 marker, even with fully filled input, is refused.
  fail(rendered(filled), 'PRODUCTION_SEED_B2_REQUIRED'),
  `INSERT INTO system_settings VALUES ('runtime_environment','"production"') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
  `INSERT INTO ai_models(id,name,model_id) VALUES ${models.map((model,i) => `('${ids[i]}','Local fixture ${i}','${model}')`).join(',')};`,
  `INSERT INTO skills(id,skill_key) VALUES ('${skill}','local-production-seed-review');`,
  `CREATE TEMP TABLE seed_settings_before AS SELECT * FROM system_settings;`,
  `CREATE TEMP TABLE seed_partial_before AS ${state};`,
  ...Object.keys(required).map(key => fail(rendered({ ...filled, [key]: null }), `PRODUCTION_SEED_REPLACE_REQUIRED: ${key}`)),
  ...Object.keys(required).map(key => {
    const without = { ...filled }; delete without[key];
    return fail(rendered(without), 'PRODUCTION_SEED_INPUT_KEYS_REQUIRED');
  }),
  fail(rendered({ ...filled, unrelated_key: true }), 'PRODUCTION_SEED_INPUT_KEYS_REQUIRED'),
  fail(rendered({ ...filled, fusion_settings: { ...filled.fusion_settings, review: { ...filled.fusion_settings.review,
    maxBudgetUsd: null } } }), 'PRODUCTION_SEED_REPLACE_REQUIRED: fusion_settings'),
  ...['maxBudgetUsd','opinionOutputTokens','summaryOutputTokens','dispatchMinutes','breaker'].map(field => {
    const review = { ...filled.fusion_settings.review }; delete review[field];
    return fail(rendered({ ...filled, fusion_settings: { ...filled.fusion_settings, review } }), 'PRODUCTION_SEED_FUSION_REQUIRED');
  }),
  unchanged('seed_partial_before'),
  fail(rendered({ ...filled, primary_model_id: ids[5] }), 'PRODUCTION_SEED_MODEL_REQUIRED: primary_model_id'),
  fail(rendered({ ...filled, runtime_purpose_budgets: {} }), 'PRODUCTION_SEED_BUDGET_STRING_REQUIRED'),
  ...[{}, { version: 2, interactive: null, organize: null, report: null },
    { ...JSON.parse(filled.runtime_purpose_budgets), interactive: { inputBytes: 90001, historyItems: 100 } },
    { ...JSON.parse(filled.runtime_purpose_budgets), interactive: { inputBytes: 90000, historyItems: 0.5 } },
  ].map(budget => fail(rendered({ ...filled, runtime_purpose_budgets: JSON.stringify(budget) }),
    'PRODUCTION_SEED_FROZEN_BUDGET_REQUIRED')),
  ...[[{}], [{ model: models[0], purpose: 'skill', typicalUsd: 0.01 }],
    [{ model: models[0], purpose: 'skill', typicalUsd: '0.01', credits: 10 }],
    Array(2).fill({ model: models[0], purpose: 'skill', credits: 10 }),
  ].map(thresholds => fail(rendered({ ...filled, billing_payg_start_thresholds: { version: 'local', thresholds } }),
    'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED')),
  ...['3','3.5'].map(maxBudgetUsd => fail(rendered({ ...filled, fusion_settings: { ...filled.fusion_settings,
    compare: { ...filled.fusion_settings.compare, maxBudgetUsd } } }), 'PRODUCTION_SEED_FUSION_REQUIRED')),
  fail(rendered({ ...filled, fusion_settings: { ...filled.fusion_settings, review: { ...filled.fusion_settings.review,
    reviewerModelIds: [ids[0],ids[2],ids[1]] } } }), 'PRODUCTION_SEED_FUSION_IMPORT_REQUIRED'),
  fail(rendered({ ...filled, publish_monitor_publish_quota: { ...filled.publish_monitor_publish_quota, limit: 0 } }),
    'PRODUCTION_SEED_PUBLISH_QUOTA_REQUIRED'),
  unchanged('seed_partial_before'),
  rendered(filled), verify, read('packages/db/tests/production-seed/catalog.sql'),
  `CREATE TEMP TABLE seed_first AS ${state};`,
  // A separate transaction means an unconditional updated_at=now() would fail the equality check.
  rendered(filled), unchanged('seed_first'),
  // Existing catalog identities and derived external-price columns are not replaced on a re-apply.
  `UPDATE membership_plans SET id='90000000-0000-4000-8000-000000000030' WHERE level='pro';`,
  rendered(filled),
  `DO $$ BEGIN IF (SELECT id FROM membership_plans WHERE level='pro') <> '90000000-0000-4000-8000-000000000030'::uuid
    THEN RAISE EXCEPTION 'existing plan ID overwritten'; END IF; END $$;`,
  read('packages/db/tests/production-seed/mapped-price.sql').replaceAll('__FILLED_SEED__', () => body(rendered(filled))),
  `DO $$ BEGIN IF (${objects}) IS DISTINCT FROM (SELECT * FROM seed_schema_before)
    THEN RAISE EXCEPTION 'seed changed persistent schema'; END IF; END $$;`,
  `SELECT 'PASS production seed: 20 typed settings, 3 plans, 3 packs; placeholders/atomic failure/replay/mapped prices/schema';`,
].join('\n');
const temp = mkdtempSync(resolve(tmpdir(), 'graylum-production-seed-'));
try {
  const path = resolve(temp, 'cases.sql');
  writeFileSync(path, cases);
  const result = spawnSync(process.execPath, ['packages/db/tests/run-db-baseline-replay.mjs', mode, '--after', path], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(mode === '--ci' ? { CI: process.env.CI } : {}) },
    encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'disposable database seed checks failed');
} finally { rmSync(temp, { recursive: true, force: true }); }
