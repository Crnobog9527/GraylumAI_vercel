/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * Layer-1 simulated-model browser tests (scripts/e2e-sim): seeds the disposable local database with what the core path needs and
 * nothing else. Refuses any database that is not the local disposable one. Same shapes as the turn integration tests
 * (services/turn/chat.integration.ts): synthetic prices and admission profiles, the core-path switch, a synthetic platform key.
 * Usage: tsx seed.ts <connection json> <output json>   (connection: {dbUrl, apiUrl, serviceJwt}, a private file the runner writes)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { pricingConfig } from '../../services/__tests__/fixtures/runtimePricing';
import { seedTestOpenRouterKey } from '../../services/models/openRouterKey.testing';
import { paygProductionSettings } from '../../services/turn/admission/paygHostPolicy';
import { CORE_PATH_SETTING, RUNTIME_PAYG_SETTING } from '../../services/turn/settingKeys';

const connection = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as { dbUrl?: string; apiUrl?: string; serviceJwt?: string };
const dbUrl = connection.dbUrl ?? '', apiUrl = connection.apiUrl ?? '', service = connection.serviceJwt ?? '';
if (!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/sim$/.test(dbUrl) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl) || !service)
  throw new Error('local disposable simulation database required');

/** The simulated models: the free-chat model and a second one for compare. Ids are OpenRouter-style; nothing leaves the machine. */
export const SIM_MODELS = [
  { name: 'Sim Chat', modelId: 'anthropic/claude-sonnet-5.5', route: 'anthropic' },
  { name: 'Sim Second', modelId: 'google/gemini-3.8-flash', route: 'google-vertex' },
] as const;

// Synthetic admission evidence for local validation only (the shape productionPolicy.test.ts and chat.integration.ts use).
const profile = (model: string, route: string) => ({ model, endpointTag: route, protocol: 'openrouter-chat-v1', profileVersion: 'sim-only',
  evidenceVersion: 'sim-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128,
  maxTools: 9, maxSchemaBytes: 16384,
  purposes: ['ordinary', 'skill', 'organizer', 'skill_matching', 'attached_organizer', 'report'],
  requestFormats: ['serial-tools-v2', 'serial-tools-v4-stream', 'agent-turn-v5-stream', 'serial-tools-v6-reasoning'],
  reasoningVariants: [{ reasoning: { effort: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'sim-only',
    manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
  evidence: { reference: 'sim-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12, maxVerifiedMessages: 128,
    completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4, outputLimit: 8192, testedOutputLimit: 512,
    outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true, cacheCovered: true, costBoundPassed: true } });

async function createUser(email: string, password: string): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/v1/admin/users`, { method: 'POST',
    headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await response.json() as { id?: string };
  if (!response.ok || !body.id) throw new Error(`local user creation failed (${response.status})`);
  return body.id;
}

async function main() {
  const out = process.argv[3];
  if (!out) throw new Error('output file required');
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const set = (key: string, value: unknown) => db.query(
      'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
    const models: Record<string, string> = {};
    for (const model of SIM_MODELS) {
      const id = randomUUID();
      const { pricing } = pricingConfig(model.modelId, model.route, '0.000003', '0.000015');
      (pricing.endpoints[0]!.base as Record<string, string>).input_cache_write = '0.00000375';
      const config = { pricing, reasoning: { route: model.route, purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } },
        catalog: { fetchedAt: pricing.fetchedAt, model: model.modelId, reasoning: { mandatory: false, defaultEnabled: false,
          supportedEfforts: ['low', 'high'], defaultEffort: 'high', supportsMaxTokens: true },
        endpoints: [{ tag: model.route, providerName: 'Simulated', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'],
          contextLength: 1050000, maxCompletionTokens: 8192 }] } } };
      await db.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
        values($1,$2,$3,'openrouter','true',8192,1050000,$4,'https://openrouter.ai/api/v1/chat/completions')`,
      [id, model.name, model.modelId, JSON.stringify(config)]);
      models[model.modelId] = id;
    }
    await set(CORE_PATH_SETTING, { enabled: true, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 }, decisionUpperUsd: '0.001' });
    // Checked with the product's own schema first: a profile the app would refuse fails here, not as a vague turn refusal.
    await set(RUNTIME_PAYG_SETTING, paygProductionSettings.parse({ version: 1, enabled: true, policyVersion: 'sim',
      profiles: SIM_MODELS.map(m => profile(m.modelId, m.route)) }));
    await set('primary_model_id', models[SIM_MODELS[0].modelId]);
    await set('billing_credits_per_usd', 100);
    await set('billing_token_price_multiplier', 6);
    await set('runtime_rw_v2', { catalogCache: true });
    await set('billing_payg_start_thresholds', { version: 'sim', thresholds: SIM_MODELS.flatMap(m =>
      ['ordinary', 'mentor', 'compare'].map(purpose => ({ model: m.modelId, purpose, typicalUsd: '0.04' }))) });
    await seedTestOpenRouterKey(db, 'LOCAL_SIMULATED_OPENROUTER_KEY');

    // Two accounts: each journey that charges uses its own, so balances are exact. Passwords stay in the run's private directory.
    const users: Record<string, { id: string; email: string; password: string }> = {};
    for (const role of ['alice', 'bob']) {
      const email = `sim-${role}-${randomUUID().slice(0, 8)}@example.test`, password = randomBytes(18).toString('base64url');
      const id = await createUser(email, password);
      await db.query('insert into profiles(id,email,credits) values($1,$2,0) on conflict(id) do nothing', [id, email]);
      await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
        values($1,$3::int,'addition','grant','opening_grant','system',$2,0,$3::int)`, [id, 'opening_grant:' + id, 5000]);
      await db.query('update profiles set credits=5000 where id=$1', [id]);
      users[role] = { id, email, password };
    }
    writeFileSync(out, JSON.stringify({ users, models }, null, 2), { mode: 0o600 });
    console.log(`seeded ${SIM_MODELS.length} simulated models and ${Object.keys(users).length} accounts`);
  } finally { await db.end(); }
}

void main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); });
