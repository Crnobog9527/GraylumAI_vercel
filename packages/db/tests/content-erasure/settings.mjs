/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {erase,preview} from './cases.mjs';
export async function runSettings({db,Client,connectionString,report}){
 const f=await fixture(db),g=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const account=(await db.query('SELECT account_project_id id FROM opc_items WHERE work_item_id=$1',[g.workItem])).rows[0].id;
 const other=await fixture(db),h=(await db.query('SELECT d7_test.artifacts($1) v',[other.actor])).rows[0].v;
 await db.query("INSERT INTO opc_work_ui(actor_id,work_item_id,display_name) VALUES($1,$2,'DELETE_PRIVATE_WORK'),($3,$4,'KEEP_PRIVATE_WORK')",
  [f.actor,g.workItem,other.actor,h.workItem]);
 await db.query("INSERT INTO opc_account_ui(actor_id,account_project_id,display_name) VALUES($1,$2,'DELETE_PRIVATE_ACCOUNT')",[f.actor,account]);
 await db.query("INSERT INTO opc_publication_ui(actor_id,work_item_id,planned_date) VALUES($1,$2,'2026-10-10')",[f.actor,g.workItem]);
 const locker=new Client({connectionString});await locker.connect();
 try{
  await locker.query('BEGIN');await locker.query('SELECT * FROM opc_work_ui WHERE actor_id=$1 FOR UPDATE',[f.actor]);
  await assert.rejects(erase(db,g,'artifact',g.workItem),/CONTENT_ERASURE_BUSY/);await locker.query('ROLLBACK');
  assert.equal((await db.query('SELECT display_name FROM opc_work_ui WHERE actor_id=$1',[f.actor])).rows[0].display_name,'DELETE_PRIVATE_WORK');
  await erase(db,g,'artifact',g.workItem);await erase(db,g,'artifact',account);
  assert.equal((await erase(db,g,'artifact',g.workItem)).alreadyDeleted,true);
  for(const table of ['opc_work_ui','opc_account_ui','opc_publication_ui'])
   assert.equal((await db.query(`SELECT count(*) n FROM ${table} WHERE actor_id=$1`,[f.actor])).rows[0].n,'0');
  assert.equal((await db.query('SELECT display_name FROM opc_work_ui WHERE actor_id=$1',[other.actor])).rows[0].display_name,'KEEP_PRIVATE_WORK');
  await assert.rejects(db.query('INSERT INTO opc_work_ui(actor_id,work_item_id) VALUES($1,$2)',[f.actor,g.workItem]),/CONTENT_ERASED/);
  await assert.rejects(db.query('INSERT INTO opc_publication_ui(actor_id,work_item_id) VALUES($1,$2)',[f.actor,g.workItem]),/CONTENT_ERASED/);
  await assert.rejects(db.query("INSERT INTO opc_account_ui(actor_id,account_project_id,display_name) VALUES($1,$2,'LATE')",[f.actor,account]),/CONTENT_ERASED/);
  report.checks.push('project private UI settings physically removed, repeated deletion safe, competing writer busy, late settings denied, other actor retained');
 }finally{await locker.query('ROLLBACK');await locker.end();}
 // Multiple deliberately unsorted evidence identities must produce canonical scope sets.
 for(const id of [randomUUID(),randomUUID(),randomUUID()].sort().reverse())
  await db.query("INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES($1,$2,'user','{}',$3)",[id,h.project,'a'.repeat(64)]);
 const scope=await rpc(db,'content_erasure_scope',h.actor,'artifact',h.project);
 for(const key of ['sessions','executions','projects','versions','contents','references'])
  assert.deepEqual(scope[key],[...new Set(scope[key])].sort(),`${key} is a sorted unique set`);
 const first=await preview(db,h,'artifact',h.project);
 await db.query('SET enable_seqscan=off');
 const second=await preview(db,h,'artifact',h.project);
 await db.query('RESET enable_seqscan');
 assert.equal(first.previewHash,second.previewHash);
 assert.equal((await erase(db,h,'artifact',h.project,first.previewHash)).status,'deleted');
 report.checks.push('all preview scope arrays are sorted/deduplicated; alternate planner keeps unchanged preview hash valid');
}
