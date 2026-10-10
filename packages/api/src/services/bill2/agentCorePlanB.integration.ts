/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll, afterAll, expect, it} from 'vitest';
import {randomUUID, createHash} from 'node:crypto';
import pg from 'pg';
import {overlap} from '../__tests__/fixtures/planBConcurrency';
import {planBPayg} from '../__tests__/fixtures/planBPayg';
import {annualReleaseFixture} from '../__tests__/fixtures/planBAnnualRelease';
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({connectionString});
beforeAll(() => db.connect()); afterAll(() => db.end());
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function rpc(client: pg.Client, name: string, ...args: unknown[]) {
  return (await client.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) value`, args)).rows[0].value;
}
async function fixture(v2: boolean) {
  const actor = randomUUID(), modelId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`, [actor, randomUUID()]);
  await db.query("insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Plan B fixture','fixture','true')",
    [modelId, 'plan-b-' + modelId]);
  const draft = await rpc(db, 'bill2_create_draft', actor);
  const payload = {contractVersion: 'bill2.v1', mode: 'isolated', scope: {kind: 'positioning_draft', draftId: draft},
    operation: 'question', modelId, sourceHash: hash('fixed sample'), input: {text: 'Fixed plan B sample'},
    callPolicy: [{modelId, provider: 'fixture', account: 'sandbox', model: 'plan-b-' + modelId,
      protocol: 'fixture-cost-v1', upperUsd: '0.01', inputLimit: 1000, outputLimit: 1000,
      automaticRetry: false, hiddenTools: false, lookupSupported: true}],
    rules: {version: 'v1', quoteVersion: 'fixture', creditsPerUsd: '1000', multiplier: '1', fx: {}},
    limits: {costUsd: '0.02', credits: 20, maxPreDeduct: 20, maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString()}};
  const payg = v2 ? await planBPayg(db, modelId, 'plan-b-' + modelId) : null;
  if (payg) {
    Object.assign(payload, {contractVersion: 'bill2.v2', callPolicy: [payg.policy]});
    Object.assign(payload.rules, {billingUnit: {version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: hash('unit')}});
    Object.assign(payload.limits, {credits: 0, maxPreDeduct: 0});
  }
  const request = randomUUID();
  const prepare = () => rpc(db, 'bill2_prepare', actor, request, payload);
  const call = (sequence: number) => ({provider: 'fixture', account: 'sandbox', model: 'plan-b-' + modelId,
    protocol: 'fixture-cost-v1', phase: sequence === 1 ? 'question' : 'organizer', requestHash: hash('request-' + sequence),
    upperUsd: '0.01', inputLimit: 1000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true, ...(payg?.quote ?? {})});
  const claim = async (run: string, sequence: number) => {
    const c = await rpc(db, 'bill2_claim', actor, run, sequence, call(sequence));
    expect((await rpc(db, 'bill2_dispatch', actor, run, c.id, c.dispatchToken)).dispatch).toBe(true);
    return c;
  };
  const receipt = (run: string, callId: string, cost: string | null, client = db) => rpc(client, 'bill2_record', actor, run, callId,
    {provider: 'fixture', account: 'sandbox', model: 'plan-b-' + modelId, protocol: 'fixture-cost-v1',
      providerId: 'generation-' + callId, source: 'response', sourceHash: hash(callId + cost),
      observedAt: new Date().toISOString(), coverage: 'request_total', final: cost !== null, cost, currency: 'USD', usage: cost === null ? {} : {inputTokens: Math.round(Number(cost) * 1e6), outputTokens: 0}});
  return {actor, request, payload, prepare, call, claim, receipt};
}
const delivered = {kind: 'usable_result', evidenceRef: 'fixed-result', evidenceHash: hash('fixed result')};
async function balance(actor: string) {
  const row = (await db.query(`select credits,
    (select coalesce(sum(amount),0)::int from credit_transactions where user_id=p.id) ledger,
    (select count(*)::int from credit_transactions where user_id=p.id and reason_code='bill2_reserve') reserves,
    (select count(*)::int from credit_transactions where user_id=p.id and reason_code='bill2_release') releases,
    (select coalesce(sum(-amount),0)::int from credit_transactions where user_id=p.id and counts_as_spend) spend
    from profiles p where p.id=$1`, [actor])).rows[0];
  expect(row.credits).toBe(row.ledger); expect(row.credits).toBeGreaterThanOrEqual(0); return row;
}
for (const v2 of [false, true]) {
const version = v2 ? 'v2' : 'v1';
const reservations = v2 ? 2 : 1;
it(`RUNTIME: ${version} R13.2/6 a reply and organizer share one run and one rounding under duplicate claims`, async () => {
  const f = await fixture(v2), run = await f.prepare(); expect(await f.prepare()).toEqual(run);
  const primary = await f.claim(run.id, 1); await f.receipt(run.id, primary.id, '0.0004');
  const args = [f.actor, run.id, 2, f.call(2)];
  const race = await overlap(db, connectionString, 'select id from bill2_runs where id=$1 for update', [run.id],
    a => rpc(a, 'bill2_claim', ...args), b => rpc(b, 'bill2_claim', ...args));
  expect(race.other).toMatchObject({ok: true, value: {id: race.value.id, dispatchToken: null}});
  expect((await rpc(db, 'bill2_dispatch', f.actor, run.id, race.value.id, race.value.dispatchToken)).dispatch).toBe(true);
  await f.receipt(run.id, race.value.id, '0.0004');
  await rpc(db, 'bill2_close', f.actor, run.id, 'delivered', delivered);
  expect(await rpc(db, 'bill2_finalize', f.actor, run.id)).toMatchObject({state: 'settled', chargedCredits: 1});
  expect(await balance(f.actor)).toMatchObject({credits: 99, reserves: reservations, releases: reservations, spend: 1});
  await expect(rpc(db, 'bill2_claim', f.actor, run.id, 3, f.call(3))).rejects.toThrow();
});
it.each(['not-dispatched', 'known-cost', 'unknown-timeout'])(
  `RUNTIME: ${version} R13.7/9/15 organizer %s releases only the safely resolved reservation`, async mode => {
    const f = await fixture(v2), run = await f.prepare(), primary = await f.claim(run.id, 1);
    await f.receipt(run.id, primary.id, '0.003');
    const organizer = mode === 'not-dispatched' ? null : await f.claim(run.id, 2);
    if (organizer) await f.receipt(run.id, organizer.id, mode === 'unknown-timeout' ? null : '0.002');
    await rpc(db, 'bill2_cancel', f.actor, run.id);
    let result = await rpc(db, 'bill2_finalize', f.actor, run.id);
    if (mode === 'unknown-timeout') {
      expect(result.state).toBe('cost_pending');
      expect(await balance(f.actor)).toMatchObject({credits: v2 ? 88 : 80, releases: v2 ? 1 : 0});
      await f.receipt(run.id, organizer!.id, '0.002');
      result = await rpc(db, 'bill2_finalize', f.actor, run.id);
    }
    const charge = mode === 'not-dispatched' ? 3 : 5;
    expect(result).toMatchObject({state: 'settled', chargedCredits: charge});
    const settled = await balance(f.actor);
    const count = mode === 'not-dispatched' ? 1 : reservations;
    expect(settled).toMatchObject({credits: 100 - charge, reserves: count, releases: count, spend: charge});
    await rpc(db, 'bill2_cancel', f.actor, run.id); await rpc(db, 'bill2_finalize', f.actor, run.id);
    expect(await balance(f.actor)).toEqual(settled);
  });
it(`RUNTIME: ${version} R13.12 failure refund overlapping a late organizer receipt cannot recharge or double refund`, async () => {
  const f = await fixture(v2), run = await f.prepare(), primary = await f.claim(run.id, 1);
  await f.receipt(run.id, primary.id, '0.003');
  const organizer = await f.claim(run.id, 2); await f.receipt(run.id, organizer.id, null);
  await rpc(db, 'bill2_close', f.actor, run.id, 'confirmed_failure',
    {kind: 'confirmed_delivery_failure', evidenceRef: 'fixed-failure', evidenceHash: hash('failure')});
  const evidence = {provider: 'fixture', account: 'sandbox', model: f.call(2).model, protocol: 'fixture-cost-v1',
    providerId: 'generation-' + organizer.id, source: 'lookup', sourceHash: hash('late'), observedAt: new Date().toISOString(),
    coverage: 'request_total', final: true, cost: '0.002', currency: 'USD', usage: {inputTokens: 2000, outputTokens: 0}};
  const race = await overlap(db, connectionString, 'select id from bill2_runs where id=$1 for update', [run.id],
    a => rpc(a, 'bill2_finalize', f.actor, run.id), b => rpc(b, 'bill2_record', f.actor, run.id, organizer.id, evidence));
  expect(race.value.state).toBe('refunded'); expect(race.other.ok).toBe(true);
  expect((await rpc(db, 'bill2_finalize', f.actor, run.id)).state).toBe('refunded');
  expect(await balance(f.actor)).toMatchObject({credits: 100, reserves: reservations, releases: reservations, spend: v2 ? 3 : 0});
});
it.each(['release-first', 'settle-first'])(
  `RUNTIME: ${version} R13.13 monthly credit release and organizer settlement serialize (%s)`, async mode => {
    const f = await fixture(v2), annual = await annualReleaseFixture(db, f.actor);
    try {
      const run = await f.prepare(), primary = await f.claim(run.id, 1);
      await f.receipt(run.id, primary.id, '0.003');
      const organizer = await f.claim(run.id, 2);
      if (!v2) {
        await f.receipt(run.id, organizer.id, '0.002');
        await rpc(db, 'bill2_close', f.actor, run.id, 'delivered', delivered);
      }
      const settle = (c: pg.Client) => v2 ? f.receipt(run.id, organizer.id, '0.002', c) : rpc(c, 'bill2_finalize', f.actor, run.id);
      const race = await overlap(db, connectionString, 'select id from profiles where id=$1 for update', [f.actor],
        mode === 'release-first' ? annual.release : settle, mode === 'release-first' ? settle : annual.release);
      expect(race.other.ok).toBe(true);
      expect(await balance(f.actor)).toMatchObject({credits: 297, reserves: reservations, releases: reservations, spend: 5});
      await annual.release(db); await settle(db);
      expect(await balance(f.actor)).toMatchObject({credits: 297, reserves: reservations, releases: reservations, spend: 5});
      expect((await db.query('select count(*)::int n from subscription_credit_grants where user_id=$1', [f.actor])).rows[0].n).toBe(2);
    } finally {await annual.restore();}
  });

}
