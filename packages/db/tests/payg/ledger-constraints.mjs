/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX E3 (0385): one pre-deduction per (user, requestId), and every ledger row has an idempotency key.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const profile = async (db,credits=100) => {
  const id = randomUUID();
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,$2)',[id,credits]);
  return id;
};
const credits = async (db,id) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[id])).rows[0].credits;
const preDeduct = (db,user,request,amount=10) =>
  db.query("SELECT * FROM atomic_pre_deduct($1,$2,'E3 local',$3)",[user,amount,request]).then(r=>r.rows[0]);

export async function ledgerConstraintCases({db,Client,connectionString,report}) {
  // Repeat: the same request deducts once and returns the first pre-deduction.
  const user = await profile(db), request = randomUUID();
  const first = await preDeduct(db,user,request);
  const again = await preDeduct(db,user,request);
  assert.deepEqual([first.is_idempotent,again.is_idempotent,again.pre_deduct_id],[false,true,first.pre_deduct_id]);
  assert.equal(await credits(db,user),90);

  // Concurrent: the second call waits for the first one's profile lock, then returns the same pre-deduction.
  const racer = await profile(db), shared = randomUUID();
  const [a,b] = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all([a.connect(),b.connect()]);
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    const held = await preDeduct(a,racer,shared);
    const waiting = preDeduct(b,racer,shared);
    await new Promise(resolve=>setTimeout(resolve,300));
    await a.query('COMMIT');
    const second = await waiting;
    await b.query('COMMIT');
    assert.deepEqual([held.is_idempotent,second.is_idempotent,second.pre_deduct_id],[false,true,held.pre_deduct_id]);
  } finally { await a.end(); await b.end(); }
  assert.equal(await credits(db,racer),90,'concurrent same request deducts once');
  assert.equal((await db.query(`SELECT count(*)::int n FROM billing_history WHERE user_id=$1 AND operation_type='pre_deduct'`,[racer])).rows[0].n,1);

  // The index refuses a second pre-deduction row for the same request, whoever writes it.
  await assert.rejects(db.query(`INSERT INTO billing_history(user_id,operation_type,amount,reason,metadata)
    VALUES($1,'pre_deduct',-1,'dup',jsonb_build_object('requestId',$2::text))`,[racer,shared]),/billing_history_pre_deduct_request/);

  // Every ledger row has a key: a writer that omits it is refused; the former keyless writers now set one.
  await assert.rejects(db.query(`INSERT INTO credit_transactions(user_id,amount,type,description) VALUES($1,1,'addition','no key')`,[user]),
    /idempotency_key/);
  const adjusted = (await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1,5,'addition','[Admin] local')",[user])).rows[0];
  assert.match((await db.query('SELECT idempotency_key k FROM credit_transactions WHERE id=$1',[adjusted.transaction_id])).rows[0].k,/^ledger:/);
  const keyed = (await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1,5,'addition','[Admin] local','admin_adjustment:e3')",[user])).rows[0];
  const replay = (await db.query("SELECT * FROM atomic_apply_credit_ledger_entry($1,5,'addition','[Admin] local','admin_adjustment:e3')",[user])).rows[0];
  assert.deepEqual([replay.is_idempotent,replay.transaction_id],[true,keyed.transaction_id],'a caller key stays idempotent');
  // Check-in was retired (0396): the former keyless writer is gone; its keyed history rows stay valid.
  assert.equal((await db.query("SELECT to_regproc('public.claim_daily_checkin') IS NULL gone")).rows[0].gone,true);
  const checkin = await profile(db,0);
  await db.query(`INSERT INTO credit_transactions(idempotency_key,user_id,amount,type,description)
    VALUES('checkin:'||$1::text||':2026-10-25',$1::uuid,5,'checkin','每日签到奖励（第1天）')`,[checkin]);
  report.checks.push('E3: same request pre-deducts once (repeat and concurrent); duplicate request row refused; keyless ledger insert refused; admin entries carry keys; retired check-in RPC gone, keyed check-in history accepted');
}
