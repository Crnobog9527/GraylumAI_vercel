/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0232: renaming an ordinary conversation; the name is erased with the conversation and the account.
import assert from 'node:assert/strict';
import {runtimeFixture,erase} from './cases.mjs';
import {rpc,fixture,closeAccount} from '../erasure-b2a/cases.mjs';
const rename=(db,f,name,id=f.session)=>rpc(db,'opc_conversation_rename',f.actor,id,name);
const names=async(db,f)=>(await db.query('SELECT name FROM runtime_session_names WHERE session_id=$1',[f.session])).rows;
async function listed(db,f){
 await db.query(`UPDATE runtime_executions SET payload='{"role":"ordinary","input":"原始问题"}' WHERE id=$1`,[f.execution]);
 return (await rpc(db,'opc_free_conversations',f.actor)).find(row=>row.sessionId===f.session);
}
export async function runRename({db,report}){
 // Allow: the owner renames, the list shows the name, an empty name restores the default.
 const f=await runtimeFixture(db,{settled:true});
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(rename(db,f,'x'),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM runtime_session_names'),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 assert.deepEqual(await rename(db,f,'  周末选题  '),{sessionId:f.session,name:'周末选题'});
 await db.query('RESET ROLE');
 const row=await listed(db,f);
 assert.ok(row,'fixture conversation is listed');assert.equal(row.title,'周末选题');
 await rename(db,f,'改个名字');
 assert.equal((await listed(db,f)).title,'改个名字');
 assert.equal((await rename(db,f,'   ')).name,null);
 assert.notEqual((await listed(db,f)).title,'改个名字','empty name restores the default title');
 await assert.rejects(rename(db,f,'x'.repeat(81)),/CONVERSATION_NAME_INVALID/);
 await assert.rejects(rename(db,f,'a\nb'),/CONVERSATION_NAME_INVALID/);
 report.checks.push('rename: owner only, trimmed, shown in the list, empty restores default, invalid refused');

 // Deny: another account, and a conversation that is not a free conversation.
 const other=await fixture(db);
 await assert.rejects(rename(db,{...f,actor:other.actor},'偷改'),/CONVERSATION_NOT_FOUND/);
 const work=await runtimeFixture(db,{settled:true});
 await db.query(`UPDATE runtime_sessions SET scope=scope||'{"kind":"positioning_topic"}' WHERE id=$1`,[work.session]);
 await assert.rejects(rename(db,work,'工作'),/CONVERSATION_NOT_FOUND/);
 // The table itself refuses a name owned by someone other than the conversation's owner.
 await assert.rejects(db.query('INSERT INTO runtime_session_names(session_id,actor_id,name) VALUES($1,$2,$3)',
  [f.session,other.actor,'别人的名字']),/CONVERSATION_NAME_OWNER_MISMATCH/);
 await rename(db,f,'自己的名字');
 await assert.rejects(db.query('UPDATE runtime_session_names SET actor_id=$2 WHERE session_id=$1',[f.session,other.actor]),
  /CONVERSATION_NAME_OWNER_MISMATCH/);
 report.checks.push('rename denied for another account and for non-free conversations; table enforces the owner');

 // Erased with the conversation; a deleted conversation cannot be renamed again.
 await rename(db,f,'会被删除的名字');
 await erase(db,f,'session',f.session);
 assert.deepEqual(await names(db,f),[]);
 await assert.rejects(rename(db,f,'复活'),/CONTENT_ERASED/);
 assert.deepEqual(await names(db,f),[]);
 report.checks.push('name deleted with the conversation; renaming a deleted conversation refused');

 // Erased with the account, and counted by the completion proof until then.
 const g=await runtimeFixture(db,{settled:true});
 await rename(db,g,'注销前的名字');
 const before=Number(await rpc(db,'account_erasure_body_remaining',g.actor));
 await closeAccount(db,g);
 const counts=await rpc(db,'account_erasure_scrub_content',g.actor);
 assert.equal(counts.runtime_session_names_deleted,1);
 assert.deepEqual(await names(db,g),[]);
 assert.ok(Number(await rpc(db,'account_erasure_body_remaining',g.actor))<before,'proof counted the name');
 await rpc(db,'account_erasure_scrub_runtime',g.actor);
 report.checks.push('account erasure deletes names and its completion proof counts them');
}
