/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture as v1Fixture} from '../erasure-b2a/cases.mjs';

const names = ['settle','refund','abort_settle','finalize_ai_success','finalize_ai_failure','finalize_ai_abort'];
const args = (name, actor, pre, conversation) => {
  if (name === 'settle') return [actor,pre,4,{},null];
  if (name === 'refund') return [actor,pre,'local test'];
  if (name === 'abort_settle') return [actor,pre,4,{},'legacy','local test'];
  if (name === 'finalize_ai_failure') return [actor,'legacy','local test',pre];
  return [actor,conversation,'local question','local answer','legacy','0.004',4,pre];
};
const balance = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const history = async (db,actor) => (await db.query(
  'SELECT * FROM billing_history WHERE user_id=$1 ORDER BY id',[actor]
)).rows;

export async function legacyCases(db, report, createFixture, claim) {
  const old = await v1Fixture(db);
  const fresh = await createFixture(db);
  const c = await claim(db,fresh,1,false);
  const pre = (await db.query('SELECT pre_deduct_id FROM bill2_calls WHERE id=$1',[c.id])).rows[0].pre_deduct_id;
  assert.ok(pre);
  for (const [version,f,p] of [['v1',old,old.pre],['v2',fresh,pre]]) {
    const before = await balance(db,f.actor);
    const rows = await history(db,f.actor);
    for (const name of names) {
      await assert.rejects(rpc(db,'atomic_'+name,...args(name,f.actor,p,randomUUID())),/BILL2_LEGACY_FINALIZER_DENIED/);
      assert.equal(await balance(db,f.actor),before);
      assert.deepEqual(await history(db,f.actor),rows);
    }
    report.checks.push(`${version}: all six public legacy finalizers refuse BILL2 pre-deductions without mutation`);
  }
  for (const name of names) {
    const f = await v1Fixture(db);
    const before = await balance(db,f.actor);
    const p = (await db.query('SELECT * FROM atomic_pre_deduct($1,10,$2,$3)',[f.actor,'legacy',randomUUID()])).rows[0];
    const conversation = randomUUID();
    await db.query('INSERT INTO conversations(id,user_id,title) VALUES($1,$2,$3)',[conversation,f.actor,'local test']);
    const result = await rpc(db,'atomic_'+name,...args(name,f.actor,p.pre_deduct_id,conversation));
    assert.ok(result);
    assert.equal(await balance(db,f.actor),before-(name.includes('failure')||name==='refund'?0:4),name);
    report.checks.push(`ordinary legacy wallet: atomic_${name} preserves its original result`);
  }
}
