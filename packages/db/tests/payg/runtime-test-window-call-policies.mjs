/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0327 changes only the staging test-window call-policy cardinality ceiling.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function runtimeTestWindowCallPoliciesCases(db,report) {
  const constraint=async name=>(await db.query(`SELECT pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE conrelid='public.runtime_test_windows'::regclass AND conname=$1`,[name])).rows[0]?.definition;
  const policyDefinition=await constraint('runtime_test_windows_call_policies_check');
  assert.match(policyDefinition,/jsonb_typeof\(call_policies\).*'array'.*jsonb_array_length\(call_policies\) >= 1.*jsonb_array_length\(call_policies\) <= 32/);
  for (const [count,accepted] of [[1,true],[16,true],[32,true],[0,false],[33,false]]) {
    const values=Array.from({length:count},(_,index)=>({policy:index}));
    const insert=db.query(`INSERT INTO runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,
      multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,false,'{}',$2,1,1,1,1,now())`,
    [randomUUID(),JSON.stringify(values)]);
    if (accepted) await insert;
    else await assert.rejects(insert,/runtime_test_windows_call_policies_check/);
  }
  await assert.rejects(db.query(`INSERT INTO runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,
    multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,false,'{}','{}',1,1,1,1,now())`,[randomUUID()]),
  /runtime_test_windows_call_policies_check/);
  assert.match(await constraint('runtime_test_windows_actor_ids_check'),/cardinality\(actor_ids\) >= 1.*cardinality\(actor_ids\) <= 8/);
  assert.match(await constraint('runtime_test_windows_max_cost_usd_check'),/100/);
  assert.match(await constraint('runtime_test_windows_max_calls_check'),/1000/);
  report.checks.push('0327 admits 1..32 call policies, rejects 0/33/non-arrays, and preserves other window rules');
}
