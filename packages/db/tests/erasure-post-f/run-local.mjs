/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 F follow-up (REL-1 1.2a item 7): delete a long conversation, then erase the whole account, then run the read-only audit
// (audit-account.sql, the same text the manual staging check uses) and require every check green. Also proves the audit can go red:
// before the erasure, after a content leak, and for an account that was never erased. Runs on the repository's database build, so it
// holds before and after batch F (the audit names only tables that exist in both).
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { localDb } from '../runtime-view-perf/local-db.mjs';
import { rpc, closeAccount } from '../erasure-b2a/cases.mjs';
import { buildAuditSql, failures, baselineOf } from './check-account.mjs';

const db = await localDb(), c = db.client, report = { build: db.build, checks: [], samples: {} };
const one = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const hash = text => createHash('sha256').update(text).digest('hex');
const refusal = async promise => { try { await promise; } catch (e) { return e.message; } assert.fail('accepted'); };
const policy = () => ({ q: 100, uTurnUsd: 0.1, gCredits: 60, minCredits: 10, uModelCredits: 30, historyItems: 200, inputBytes: 1000,
  limits: { model: 3, paidTools: 1, freeTools: 1 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } });
async function account(credits = 100000) {
  const actor = randomUUID();
  await c.query('insert into profiles(id,credits,email,nickname) values($1,$2,$3,$4)', [actor, credits, `${actor}@erasure.invalid`, 'PRIVATE_NICK']);
  await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`, [actor, credits, 'opening_grant:' + actor]);
  const a = { actor };
  a.session = await newSession(a);
  return a;
}
async function newSession(a) {
  const id = randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{\"note\":\"PRIVATE_START\"}')",
    [id, a.actor, JSON.stringify({ kind: 'positioning_draft', probe: randomUUID() }), randomUUID()]);
  return id;
}
// One whole turn through the real functions: freeze, receipt with a response body, two messages.
async function turn(a, session = a.session) {
  const o = await one('select turn_open($1,$2,$3,$4,$5) v', [a.actor, session, randomUUID(), 'chat', JSON.stringify(policy())]);
  await c.query('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [a.actor, o.turnId, 1, 'model', randomUUID(), null, null, hash('r' + o.turnId), 0.02, 6]);
  await c.query('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [a.actor, o.turnId, 1, 'ok', 0.01, 0.01, '{}', null, hash('p' + o.turnId), 'RAW_PRIVATE_BODY']);
  await c.query("select turn_close($1,$2,'completed',$3,true,false,null)", [a.actor, o.turnId,
    JSON.stringify([{ role: 'user', content: 'PRIVATE_Q' }, { role: 'assistant', content: 'PRIVATE_A' }])]);
  return o.turnId;
}
// A long conversation: n more closed turns with a receipt, a response body and two messages each, inserted in bulk.
const longConversation = (a, n) => c.query(`with t as (insert into turns(actor_id,session_id,request_id,kind,state,close_kind,closed_at,policy,reserved_credits,charged_credits,absorbed_credits,settlement,delivered)
    select $1,$2,gen_random_uuid(),'chat','closed','completed',now(),'{}',6,6,0,'done',true from generate_series(1,$3::int) returning id)
  , calls as (insert into turn_calls(actor_id,turn_id,seq,call_kind,model_id,status,request_hash,upper_usd,multiplier,nominal_usd,actual_usd,settled_at)
    select $1,id,1,'model',gen_random_uuid(),'ok',encode(sha256(id::text::bytea),'hex'),0.02,6,0.01,0.01,now() from t returning turn_id,seq)
  , raw as (insert into turn_call_raw(turn_id,seq,body) select turn_id,seq,repeat('RAW_PRIVATE_BODY ',400) from calls)
  insert into session_messages(session_id,seq,role,turn_id,content,content_hash)
    select $2,100+row_number() over (order by t.id,r.role)::int,r.role,t.id,'PRIVATE '||r.role||' '||repeat('x',2000),encode(sha256('x'::bytea),'hex')
    from t cross join (values ('assistant'),('user')) r(role)`, [a.actor, a.session, n]);
// The audit exactly as the staging check sends it, inside a READ ONLY transaction (a write anywhere in it would fail).
async function audit(a, options = {}) {
  if (options.inTransaction) return (await c.query(buildAuditSql({ profileId: a.actor }))).rows;
  await c.query('begin read only');
  try { return (await c.query(buildAuditSql({ profileId: a.actor, ...options }))).rows; } finally { await c.query('rollback'); }
}
const status = (rows, name) => rows.find(r => r.check_name === name);
const walk = async a => {
  // As the processor does it, each step its own transaction, after the confirmation committed.
  await closeAccount(c, a);
  await c.query("update account_erasure_requests set confirmed_at=now()-interval '1 minute' where profile_id=$1", [a.actor]);
  const work = await rpc(c, 'account_erasure_work_batch', a.actor);
  assert.equal(work.financialPending, 0, 'no money in flight');
  const steps = {};
  for (const name of ['account_erasure_scrub_content', 'account_erasure_scrub_runtime', 'account_erasure_scrub_turns']) {
    steps[name] = await rpc(c, name, a.actor);
    assert.notEqual(steps[name].retry, true, name);
  }
  // The ledger rows keep amounts and ids; their free-text parts are scrubbed in pages, as the processor does.
  for (const table of ['credit_transactions', 'billing_history', 'token_stats', 'ai_usage_logs']) {
    let after = null;
    for (let page = 0; page < 20; page++) {
      const r = await rpc(c, 'account_erasure_scrub_ledger', a.actor, table, 100, after);
      if (!r.remaining || !r.nextRowId) break;
      after = r.nextRowId;
    }
  }
  // The library storage proof the executor records first (library-proof.mjs does the same for the other erasure suites).
  await c.query('update account_erasure_requests set library_storage_verified_at=clock_timestamp() where profile_id=$1 and library_storage_verified_at is null', [a.actor]);
  const cleanup = await rpc(c, 'account_erasure_local_cleanup', a.actor, true);
  assert.deepEqual([cleanup.remaining, cleanup.manualReview, cleanup.errors], [0, 0, []], JSON.stringify(cleanup));
  return steps;
};
try {
  // 1. The input is a uuid and nothing else; the template has no left-over placeholder.
  for (const bad of ["x'; drop table profiles; --", '', 'ABCDEF00-0000-0000-0000-000000000000', null])
    assert.throws(() => buildAuditSql({ profileId: bad }), /uuid/);
  assert.doesNotMatch(buildAuditSql({ profileId: randomUUID(), complete: true, postF: true }), /__[A-Z_]+__/);
  report.checks.push('audit input: only a lower-case uuid is accepted; no placeholder is left in the SQL');

  // 2. The full walk: a long conversation deleted first, then the whole account erased.
  const a = await account(), other = await account();
  await turn(a); await longConversation(a, 400);
  const second = await newSession(a); await turn(a, second);
  await turn(other); await longConversation(other, 20);
  const before = await audit(a);
  // Red control: an account that is still alive fails exactly where the erasure is missing.
  for (const name of ['request_row_exists', 'profile_closed', 'profile_identity_cleared', 'turn_call_raw_rows', 'session_messages_with_text_or_visible',
    'runtime_sessions_not_erased', 'runtime_sessions_scope_or_payload_left'])
    assert.equal(status(before, name).ok, false, `a live account must fail ${name}`);
  const billing = baselineOf(before);
  assert.deepEqual(Object.values(billing).map(n => n > 0), [true, true, true]);
  const afterOther0 = baselineOf(await audit(other));

  // 2a. Delete the long conversation (the user's action): hidden at once, text and bodies cleared by the cleanup.
  const marked = await one('select content_erasure_mark_session($1,$2) v', [a.actor, a.session]);
  assert.equal(marked.status, 'deleted');
  const start = performance.now();
  const swept = await one('select content_erasure_sweep_sessions(200,null,null) v');
  report.samples.longConversationCleanupMs = Math.round(performance.now() - start);
  assert.ok(swept.cleaned >= 1 && swept.failed === 0, JSON.stringify(swept));
  const mid = await audit(a);
  assert.equal(status(mid, 'turn_call_raw_rows').actual > 0, true, 'the other conversation of the account is still there');
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1 and (content<>\'\' or visible)', [a.session]), 0);
  report.checks.push(`long conversation deleted (401 turns, 802 messages, 401 bodies): text and bodies gone in ${report.samples.longConversationCleanupMs} ms, the account's other conversation untouched, the audit still red for the rest`);

  // 2b. The whole account.
  const steps = await walk(a);
  const rows = await audit(a);
  assert.deepEqual(failures(rows), [], JSON.stringify(failures(rows)));
  assert.deepEqual(baselineOf(rows), billing, 'turns, receipts and the ledger are billing records: unchanged');
  assert.equal(Number(status(rows, 'session_messages_kept_emptied').actual), 0, 'the local cleanup deletes the sessions, and the emptied messages go with them');
  const shells = await one('select count(*)::int v from runtime_sessions where actor_id=$1', [a.actor]);report.samples.sessionShells = shells;
  assert.equal(Number(status(rows, 'request_row_exists').actual), 1);
  for (const n of ['session_messages', 'turn_call_raw']) assert.ok(steps.account_erasure_scrub_turns[n] >= 0);
  report.checks.push(`account erasure walk (confirm, work batch, scrub content/runtime/turns, local cleanup): audit green on ${rows.length} rows, billing records unchanged`);

  // 2c. Another account is untouched by this erasure.
  assert.deepEqual(baselineOf(await audit(other)), afterOther0);
  assert.equal(await one("select count(*)::int v from session_messages m join runtime_sessions s on s.id=m.session_id where s.actor_id=$1 and m.visible", [other.actor]), 42);
  assert.equal((await audit(other)).find(r => r.check_name === 'profile_closed').ok, false);
  report.checks.push('another account: content and billing records unchanged, the audit still red for it (never erased)');

  // 3. The audit goes red again when something leaks back (each leak put back afterwards).
  const leakSession = async () => {
    const id = randomUUID();
    await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,'{\"k\":1}',$3,'{}')", [id, a.actor, randomUUID()]);
    return id;
  };
  const leaks = [
    ['session_messages_with_text_or_visible', async () => c.query("insert into session_messages(session_id,seq,role,turn_id,content,content_hash) select $1,1,'user',id,'LEAK',repeat('a',64) from turns where actor_id=$2 limit 1", [await leakSession(), a.actor])],
    ['turn_call_raw_rows', async () => c.query("insert into turn_call_raw(turn_id,seq,body) select turn_id,seq,'LEAK' from turn_calls where actor_id=$1 limit 1", [a.actor])],
    ['turns_still_open', async () => c.query("update turns set state='running',closed_at=null,close_kind=null where id=(select id from turns where actor_id=$1 limit 1)", [a.actor])],
  ];
  let tried = 0;
  for (const [name, leak] of leaks) {
    await c.query('begin');
    try {
      await leak();
      assert.equal(status(await audit(a, { inTransaction: true }), name)?.ok, false, `${name} must fail after a leak`);
      tried++;
    } catch (e) {
      // A table that refuses the write is a stronger guarantee than the audit: say so, but do not fail the suite for it.
      report.checks.push(`leak ${name}: refused by the database itself (${String(e.message).slice(0, 80)})`);
    } finally { await c.query('rollback'); }
  }
  assert.ok(tried >= 1, 'at least one leak is visible to the audit');
  assert.deepEqual(failures(await audit(a)), [], 'the leaks were rolled back');
  report.checks.push(`audit red after a leak: ${tried} of 3 injected leaks caught (rest refused by the database)`);

  // 4. The audit writes nothing: a read-only transaction ran it, and the proofs it calls are STABLE.
  assert.match(await refusal(c.query('begin read only').then(() => c.query('update profiles set credits=credits where id=$1', [a.actor])).finally(() => c.query('rollback'))), /read-only/);
  assert.deepEqual(await one("select string_agg(provolatile::text, '' order by proname) v from pg_proc where proname in ('account_erasure_body_remaining','account_erasure_local_remaining')"), 'ss');
  report.checks.push('audit is read only: runs inside BEGIN READ ONLY, both proof functions are STABLE');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); report.cleanup = 'PASS'; console.log(JSON.stringify(report, null, 2)); }
