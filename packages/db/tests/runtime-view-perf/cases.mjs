/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';

// Run the same cases against original and optimized definitions on the same data.
export async function observations(c, f) {
 const observations={};
 const attempt=async(sql,args=[])=>{
  await c.query('SAVEPOINT observe');
  try {const r=await c.query(sql,args);await c.query('RELEASE SAVEPOINT observe');return r.rows;}
  catch(e) {await c.query('ROLLBACK TO SAVEPOINT observe');return {code:e.code,message:e.message};}
 };
 const scenarios={
  allowed:async()=>{},
  disabled:()=>c.query("update profiles set status='inactive' where id=$1",[f.actor]),
  deleted:()=>c.query("update profiles set is_deleted='true' where id=$1",[f.actor]),
  revokedDraft:()=>c.query('update bill2_drafts set revoked=true where id=$1',[f.draft]),
  revokedMaterial:()=>c.query('update runtime_scope_material set revoked=true where session_id=$1',[f.session]),
  disabledModel:()=>c.query("update ai_models set is_active='false' where id=$1",[f.model]),
  unavailableAncestor:()=>c.query("update runtime_executions set unavailable_reason='source_revoked' where session_id=$1 and history_revision=0",[f.session]),
  foreignAncestor:()=>c.query("update runtime_executions set actor_id=$1 where session_id=$2 and history_revision=0",[f.otherActor,f.session]),
 };
 for(const [name,setup] of Object.entries(scenarios)) {
  await c.query('BEGIN');
  try {
   await setup();
   const availability=await attempt('select runtime_history_available(id) available from runtime_executions where session_id=$1 order by created_at,id',[f.session]);
   if(name==='allowed') assert.ok(availability.every(r=>r.available===true));
   if(['disabled','deleted','revokedDraft','disabledModel','unavailableAncestor','revokedMaterial'].includes(name)) {
    assert.ok(availability.every(r=>r.available===false),name+' must exclude all descendant history');
   }
   observations[name]={availability,
    view:await attempt('select runtime_view($1,$2)::text value',[f.actor,f.session]),
    read:await attempt("select runtime_session_items($1,$2,$3,'read')::text value",[f.actor,f.session,f.execution]),
   };
  } finally {await c.query('ROLLBACK');}
 }
 await c.query('BEGIN');
 try {
  observations.missing=await attempt('select runtime_history_available(gen_random_uuid()) value');
  observations.foreignView=await attempt('select runtime_view($1,$2)',[f.otherActor,f.session]);
  observations.limits=[];
  for(const limit of [null,0,1,7,1000,-1]) {
   observations.limits.push(await attempt("select runtime_session_items($1,$2,$3,'read',NULL,$4)::text value",[f.actor,f.session,f.execution,limit]));
  }
  observations.scopes=[];
  const scopes=[null,{}, {kind:'invalid'}, {kind:'positioning_draft'},
   {kind:'positioning_draft',draftId:f.draft}, {kind:'positioning_draft',draftId:f.draft,projectId:null},
   {kind:'positioning_topic',draftId:f.draft}, {kind:'work_item',projectId:f.draft,workItemId:f.draft},
   {kind:'positioning_draft',draftId:'bad-uuid'}, {kind:'positioning_topic',draftId:'bad-uuid'}];
  for(const scope of scopes) for(const actor of [f.actor,f.otherActor,null]) {
   observations.scopes.push(await attempt('select bill2_scope_allowed($1,$2) value',[actor,scope]));
  }
 }finally{await c.query('ROLLBACK');}
 return observations;
}
