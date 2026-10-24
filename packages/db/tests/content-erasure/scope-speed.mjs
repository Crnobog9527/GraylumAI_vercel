/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ERASE-SPEED: the frozen-material match of content_erasure_scope reads the material by its key and finds the same rows.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {outcome} from '../erasure-b2a/cases.mjs';

// The two blocks 0344 replaced in content_erasure_scope, read from the migration itself (old $a$, new $b$).
const migration=readFileSync(resolve(import.meta.dirname,'../../migrations/0344_content_erasure_scope_speed.sql'),'utf8');
const scopePatch=migration.slice(migration.indexOf("erase_speed_patch('content_erasure_scope"),
 migration.indexOf("erase_speed_patch('content_erasure_mark_session"));
const blocks=tag=>scopePatch.split(`$${tag}$`).filter((_,index)=>index%2===1);

/**
 * Every scope the local database can compute (each conversation, answer, artifact and saved content of every account),
 * with the patched function and again with the original body restored inside a rolled-back transaction: identical.
 */
export async function compareScopes(db,report,label){
 const targets=(await db.query(`SELECT actor_id a,'session' k,id FROM runtime_sessions
  UNION ALL SELECT actor_id,'answer',id FROM runtime_executions
  UNION ALL SELECT actor_id,'artifact',id FROM artifact_projects
  UNION ALL SELECT actor_id,'content',id FROM opc_content_versions ORDER BY 2,3`)).rows;
 const read=async()=>{
  const out=[];
  for(const t of targets){
   await db.query('SAVEPOINT scope_read');
   try{out.push(JSON.stringify((await db.query('SELECT content_erasure_scope($1,$2,$3) v',[t.a,t.k,t.id])).rows[0].v));
    await db.query('RELEASE SAVEPOINT scope_read');}
   catch(error){out.push('ERROR '+error.message);await db.query('ROLLBACK TO SAVEPOINT scope_read');}
  }
  return out;
 };
 const [olds,news]=[blocks('a'),blocks('b')];
 assert.equal(olds.length,2);assert.equal(news.length,2);
 await db.query('BEGIN');
 let after,before;
 try{
  after=await read();
  let definition=(await db.query("SELECT pg_get_functiondef('public.content_erasure_scope(uuid,text,uuid)'::regprocedure) d")).rows[0].d;
  assert.ok(definition.includes('-- ERASE-SPEED material key'),'0344 applied');
  for(let i=0;i<2;i++){assert.equal(definition.split(news[i]).length,2,`new block ${i} once`);definition=definition.replace(news[i],()=>olds[i]);}
  await db.query(definition);
  assert.ok(!(await db.query("SELECT pg_get_functiondef('public.content_erasure_scope(uuid,text,uuid)'::regprocedure) d")).rows[0].d
   .includes('ERASE-SPEED'),'original body restored for the comparison');
  before=await read();
 } finally { await db.query('ROLLBACK'); }
 assert.ok(targets.length>0);
 for(let i=0;i<targets.length;i++) assert.equal(after[i],before[i],`scope of ${targets[i].k} ${targets[i].id} unchanged`);
 report.checks.push(`${label}: ${targets.length} scopes identical before and after 0344 (${after.filter(v=>v.startsWith('ERROR')).length} refusals, same)`);
}
export async function runScopeSpeed(db,report){
 const f=(await db.query('SELECT runtime_perf_test.seed(1,false) v')).rows[0].v;
 // Another conversation of the same account whose frozen material (revision 1) copied the deleted one's id.
 const other=randomUUID();
 await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
  SELECT $1::uuid,actor_id,scope||jsonb_build_object('fixtureSpeed',$1::text),gen_random_uuid(),'{}' FROM runtime_sessions WHERE id=$2`,
  [other,f.session]);
 await db.query(`INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
  VALUES($1,1,$2,'{}',$3,$4)`,[other,randomUUID(),{sessionId:f.session,brief:'COPIED_FROM_DELETED'},'a'.repeat(64)]);
 const execution=async key=>{
  const id=randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
   VALUES($1,$2,$3,$4,$5,0,'completed',$6)`,[id,f.actor,other,randomUUID(),{input:'SPEED',scopeMaterial:key},outcome]);
  return id;
 };
 const given=await execution({sessionId:other,revision:1});
 const otherRevision=await execution({sessionId:other,revision:2});
 const upperKey=await execution({sessionId:other.toUpperCase(),revision:1});
 const textRevision=await execution({sessionId:other,revision:'1'});
 await compareScopes(db,report,'after the targeted cases');
 const scope=(await db.query("SELECT content_erasure_scope($1,'session',$2) v",[f.actor,f.session])).rows[0].v;
 assert.ok(scope.executions.includes(given),'an execution given the copied material is in scope');
 assert.ok(scope.executions.includes(textRevision),'the revision compares as text, as before');
 assert.ok(!scope.executions.includes(otherRevision),'another revision of the material is not');
 assert.ok(!scope.executions.includes(upperKey),'a key that does not equal the stored id as text is not, as before');
 report.checks.push(`scope material read by key: same matches (given, text revision) and non-matches (other revision, upper-case key)`);
}
