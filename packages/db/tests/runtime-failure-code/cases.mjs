/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,fixture} from '../erasure-b2a/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code));};
const fail=(db,f,e,result)=>rpc(db,'runtime_execution',f.actor,e,'fail_before_dispatch',result===undefined?null:JSON.stringify(result));
// A fresh unfinished execution with an open v1 run and no dispatched call.
async function unfinished(db) {
 const f=await fixture(db);
 return {f,e:await one(db,'SELECT b2a_test.bind($1) v',[JSON.stringify(f)])};
}
const row=(db,e)=>db.query('SELECT state,unavailable_reason,failure_code FROM runtime_executions WHERE id=$1',[e]).then(r=>r.rows[0]);
export async function runCases({db,report}) {
 const a=await unfinished(db);
 assert.equal((await fail(db,a.f,a.e,{failure_code:'BILL2_INPUT_PROFILE_INVALID'})).state,'cancelled');
 assert.deepEqual(await row(db,a.e),{state:'cancelled',unavailable_reason:null,failure_code:'BILL2_INPUT_PROFILE_INVALID'});
 assert.equal(await one(db,'SELECT state v FROM bill2_runs WHERE id=$1',[a.f.run]),'refunded');
 await fail(db,a.f,a.e,{failure_code:'OTHER_CODE'});
 assert.equal((await row(db,a.e)).failure_code,'BILL2_INPUT_PROFILE_INVALID');
 report.checks.push('fail_before_dispatch records the code with the cancellation, leaves unavailable_reason empty and never overwrites');

 const b=await unfinished(db);
 await fail(db,b.f,b.e,{unavailable_reason:'provider_history',failure_code:'RUNTIME_PROVIDER_HISTORY_DENIED'});
 assert.deepEqual(await row(db,b.e),{state:'cancelled',unavailable_reason:'provider_history',failure_code:'RUNTIME_PROVIDER_HISTORY_DENIED'});
 const c=await unfinished(db);
 await fail(db,c.f,c.e);
 assert.deepEqual(await row(db,c.e),{state:'cancelled',unavailable_reason:null,failure_code:null});
 report.checks.push('provider_history with a code, and the old no-argument call, still work');

 const d=await unfinished(db);
 for(const bad of [{failure_code:'not a code'},{failure_code:'含个人信息'},{failure_code:42},{failure_code:'X'},
  {unavailable_reason:'preflight'},{unavailable_reason:'provider_history',note:'x'},['BILL2_X']])
  await denied(fail(db,d.f,d.e,bad),'RUNTIME_FAILURE_REASON_DENIED');
 assert.equal((await row(db,d.e)).state,'interrupted');
 await denied(db.query("UPDATE runtime_executions SET failure_code='lower case' WHERE id=$1",[d.e]),'runtime_executions_failure_code_check');
 report.checks.push('free text, non-strings, other keys and other unavailable reasons are refused; the column CHECK also refuses them');

 const view=await rpc(db,'runtime_view',a.f.actor,await one(db,'SELECT session_id v FROM runtime_executions WHERE id=$1',[a.e]));
 const text=JSON.stringify(view);
 assert.ok(!/failure_?code|BILL2_INPUT_PROFILE_INVALID/i.test(text),text);
 // A code never changes availability: same answer as the identical cancellation without a code (c).
 assert.equal(await one(db,'SELECT runtime_history_available($1) v',[a.e]),await one(db,'SELECT runtime_history_available($1) v',[c.e]));
 report.checks.push('runtime_view never returns failure_code; the code does not change history availability');

 // The stream host's own cancellation: the code only when this call ends an unfinished execution.
 const cancel=(f,e,code='STAGING_RUNTIME_DISABLED')=>rpc(db,'runtime_cancel_with_code',f.actor,e,code);
 assert.equal((await cancel(d.f,d.e)).state,'cancelled');
 assert.deepEqual(await row(db,d.e),{state:'cancelled',unavailable_reason:null,failure_code:'STAGING_RUNTIME_DISABLED'});
 await cancel(c.f,c.e);
 assert.equal((await row(db,c.e)).failure_code,null);
 await cancel(a.f,a.e);
 assert.equal((await row(db,a.e)).failure_code,'BILL2_INPUT_PROFILE_INVALID');
 const other=await unfinished(db);
 await denied(cancel(a.f,other.e),'RUNTIME_EXECUTION_DENIED');
 await denied(cancel(other.f,other.e,'free text'),'RUNTIME_FAILURE_CODE_INVALID');
 assert.equal((await row(db,other.e)).state,'interrupted');
 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_cancel_with_code(uuid,uuid,text)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('runtime_cancel_with_code records the code only when it ends an unfinished execution itself; an execution already cancelled by another request keeps its own (or no) code; owner-only; service_role only');
}
