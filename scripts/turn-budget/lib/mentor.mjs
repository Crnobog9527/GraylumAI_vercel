/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A non-opening mentor turn as the database sees it (CORE-PATH-V2 plan 3.1): the one read before it, turn_open, three model calls
// (reply, one continuation, organizer) with their three receipt writes each, turn_close with the organizer's result. An
// account-strategy draft adds the mentor_source_check before close. The draft comes from the turn-core fixture; real constraints
// and triggers stay enabled.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');

// A close that writes one reply's research (V2-5c): staging's largest reply was 27 operations, 188 KB.
const researchJournal = (operations, bytes) => ({ operations: Array.from({ length: operations }, () => { const id = randomUUID();
  const item = { url: 'https://example.test/a', fields: { title: 't'.repeat(180) }, missing: [] };
  return { id, identityHash: 'a'.repeat(64), quoteUnits: 1000, state: 'succeeded', discoveryId: null,
    result: { outcome: 'ok', items: Array.from({ length: Math.ceil(bytes / JSON.stringify(item).length) }, () => item), cost: { actual: 0.001 } } }; }) });

export const mentorScenario = ({ name, accountBound, research = null }) => ({
  name, path: 'new',
  tables: ['turns', 'turn_calls', 'session_messages', 'runtime_sessions', 'profiles', 'credit_transactions', 'opc_drafts', 'artifact_rounds'],
  async setup({ client }) {
    await client.query(read('packages/db/tests/content-erasure/fixture.sql'));
    await client.query(read('packages/db/tests/turn-core/report-fixture.sql'));
    const actor = randomUUID();
    await client.query('insert into profiles(id,credits) values($1,1000)', [actor]);
    await client.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
      values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`, [actor, 'opening_grant:' + actor]);
    const source = (await client.query('select turn_test.report_source($1) v', [actor])).rows[0].v;
    await client.query(`update artifact_rounds set steps = jsonb_set(steps, '{s,fieldMeta}', '{}') where id = $1`, [source.round]);
    if (accountBound) {
      const g = (await client.query('select d7_test.artifacts($1) v', [actor])).rows[0].v;
      const account = (await client.query('select account_project_id id from opc_items where work_item_id=$1', [g.workItem])).rows[0].id;
      await client.query(`insert into opc_account_strategy_drafts(account_project_id,draft_id,actor_id,root_source_version_id,base_source_version_id,
        base_account_revision,current) values($1,$2,$3,$4,$4,0,true)`, [account, source.draft, actor, g.version]);
    }
    return { actor, source };
  },
  async run({ call, state: { actor, source } }) {
    await call('mentor_turn_prepare', [actor, source.session, true]);
    const policy = { q: 100, uTurnUsd: 0.1, gCredits: 60, minCredits: 10, uModelCredits: 30, historyItems: 100, inputBytes: 1000,
      limits: { model: 3, paidTools: 0, freeTools: 1 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
      mentor: { moduleId: source.module, stepId: 's', sourceChecked: accountBound } };
    const { turnId } = await call('turn_open', [actor, source.session, randomUUID(), 'mentor', JSON.stringify(policy)]);
    for (const seq of [1, 2, 3]) {
      await call('turn_call_begin', [actor, turnId, seq, 'model', randomUUID(), null, null, hash('r' + turnId + seq), 0.02, 6]);
      await call('turn_call_identity', [actor, turnId, seq, 'gen-' + seq]);
      await call('turn_call_record', [actor, turnId, seq, 'ok', 0.001, 0.001, '{}', null, hash('p' + turnId + seq), 'body']);
    }
    if (accountBound) await call('mentor_source_check', [actor, source.session]);
    await call('turn_close', [actor, turnId, 'completed', JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]),
      true, false, null, JSON.stringify({ roundId: source.round, revisionId: source.revision, versions: { s: 1 },
        organizerInput: { captureFormat: 'v2', userInput: 'hi' }, output: { inputKind: 'answer', patches: [], notes: [] },
        ...(research ? { research: researchJournal(research.operations, research.bytes) } : {}) })]);
  },
});
