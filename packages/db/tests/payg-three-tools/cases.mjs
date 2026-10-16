/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createFixture,claim} from '../payg/fixture.mjs';
const calls=async(db,f)=>(await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n;
const withTools=(f,tools)=>({payg:{...f.claimPayload.payg,tools}});
// B1 (0250): the absolute PAYG tool ceiling became 3 (0267 later raised it to 9); each run's own profile maxTools still applies.
export async function runCases({db,report}) {
 const two=await createFixture(db);
 await assert.rejects(claim(db,two,1,false,withTools(two,3)));
 assert.equal(await calls(db,two),0);
 report.checks.push('a run frozen with maxTools 2 still refuses a third tool before any hold');

 const before=await createFixture(db,{maxTools:3});
 const current=(await db.query("SELECT pg_get_functiondef('public.bill2_payg_validate_quote(bill2_runs,jsonb)'::regprocedure) v")).rows[0].v;
 await db.query('BEGIN');
 try {
  const needle=/least\(\(q->>'maxTools'\)::int,[39]\)/;assert.match(current,needle);
  await db.query(current.replace(needle,'least((q->>\'maxTools\')::int,2)'));
  await assert.rejects(claim(db,before,1,false,withTools(before,3)));
  report.checks.push('before 0250: even a 3-tool profile is refused by the absolute ceiling of 2');
 } finally {await db.query('ROLLBACK');}

 const three=await createFixture(db,{maxTools:3});
 await claim(db,three,1,false,withTools(three,3));
 assert.equal(await calls(db,three),1);
 report.checks.push('after 0250: a run frozen with maxTools 3 accepts a three-tool call');

 const ten=await createFixture(db,{maxTools:10});
 await assert.rejects(claim(db,ten,1,false,withTools(ten,10)));
 assert.equal(await calls(db,ten),0);
 report.checks.push('ten tools stay refused even if a profile claims more (absolute ceiling 9 since 0267)');
}
