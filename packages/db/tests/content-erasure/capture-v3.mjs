/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';
import {erase,preview} from './cases.mjs';
export async function runCaptureV3(db,report){
 const f=(await db.query('SELECT runtime_perf_test.seed(0,false) v')).rows[0].v;
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const project=randomUUID(),round=randomUUID();
 const workflow={steps:[{id:'s',information:[{id:'goal'}]}]};
 const steps={s:{version:7,valid:true,information:{goal:{value:'KEEP_CONFIRMED',status:'confirmed',nature:'fact'}},
  fieldMeta:{goal:{source:'manual'}}}};
 await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id) VALUES($1,$2,$3,$4)`,
  [project,f.actor,art.module,art.skill]);
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
  VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,[round,project,art.revision,'b'.repeat(64),workflow,'c'.repeat(64),steps]);
 const registration=(await db.query('SELECT id FROM artifact_workflows WHERE skill_id=$1',[art.skill])).rows[0].id;
 await db.query(`INSERT INTO opc_drafts VALUES($1,$2,$3,$4,$5,$6,$7,'mentor')`,
  [f.draft,f.actor,project,round,f.session,randomUUID(),registration]);
 await db.query('UPDATE modules SET model_id=$2 WHERE id=$1',[art.module,f.model]);
 const material={roundId:round,work:{projectId:project,roundId:round,revisionId:art.revision,
  packageHash:'b'.repeat(64),source:null,steps}};
 const hash=(await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[material])).rows[0].h;
 await db.query(`INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
  VALUES($1,1,$2,'{}',$3,$4)`,[f.session,randomUUID(),material,hash]);
 const executions=Array.from({length:2},()=>({id:randomUUID(),request_id:randomUUID()})).sort((a,b)=>a.id.localeCompare(b.id));
 const suggestion={value:'V3_PRIVATE_SUGGESTION',nature:'fact',basis:'user_statement'};
 for(let i=0;i<executions.length;i++){
  const e=executions[i],token=randomUUID();
  const input={captureFormat:'v2',userInput:i?'撤回之前的建议':'请更新目标',
   checklist:[{id:'s',fields:[{id:'goal',...(i?{pendingSuggestion:suggestion}:{})}]}]};
  const output={inputKind:'request',patches:i?[]:[{stepId:'s',fieldId:'goal',status:'provisional',...suggestion}],notes:[],
   ...(i?{withdrawals:[{stepId:'s',fieldId:'goal'}]}:{})};
  const payload={...f.payload,role:'skill',request:{input:'Synthetic input',requestId:e.request_id},moduleId:art.module,revisionId:art.revision,opcTurnToken:token,
   scopeMaterial:{sessionId:f.session,revision:1,hash,content:material},attachedOrganizer:{input:JSON.stringify(input)}};
  await db.query(`INSERT INTO opc_turns(token,draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash)
   VALUES($1,$2,$3,$4,$5,'s','mentor',1,$6)`,[token,f.draft,f.session,e.request_id,round,'e'.repeat(64)]);
  const billing={...f.billing,moduleId:art.module,skillId:art.skill,revisionId:art.revision,input:payload};
  const run=await rpc(db,'bill2_prepare',f.actor,randomUUID(),billing);
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,billing_run_id,history_revision,state,result,created_at)
   VALUES($1,$2,$3,$4,$5,$6,0,'completed',$7,$8)`,
   [e.id,f.actor,f.session,e.request_id,payload,run.id,{...outcome,summary:JSON.stringify(output)},new Date(1767225600000)]);
  await db.query('UPDATE bill2_runs SET session_ref=$2 WHERE id=$1',[run.id,f.session]);
  await db.query('SELECT runtime_billing_allowed($1,$2,$3)',[f.actor,billing,run.id]);
  const applied=await rpc(db,'opc_capture_apply',f.actor,f.draft,e.id);
  if(i)assert.deepEqual(applied.withdrawn,{s:['goal']});
  else assert.equal(applied.result,'suggested');
 }
 const before=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.equal(before.s.fieldMeta.goal.withdrawnSuggestion.value,suggestion.value);
 assert.equal(before.s.fieldMeta.goal.suggestion,undefined);
 assert.deepEqual(before.s.information,steps.s.information);assert.equal(before.s.version,7);assert.equal(before.s.valid,true);
 await erase(db,f,'answer',executions[0].id);
 const copied=(await db.query('SELECT payload,content_deleted_at FROM runtime_executions WHERE id=$1',[executions[1].id])).rows[0];
 assert.equal((await preview(db,f,'answer',executions[0].id)).affectedExecutions,2);
 assert.equal((await erase(db,f,'answer',executions[0].id)).alreadyDeleted,true);
 assert.ok(copied.content_deleted_at);assert.doesNotMatch(JSON.stringify(copied.payload),/V3_PRIVATE_SUGGESTION/);
 const after=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.doesNotMatch(JSON.stringify(after),/V3_PRIVATE_SUGGESTION/);
 assert.deepEqual(after.s.information,steps.s.information);assert.equal(after.s.version,7);assert.equal(after.s.valid,true);
 assert.equal(after.s.fieldMeta.goal.withdrawnSuggestion,undefined);
 const definition=(await db.query("SELECT pg_get_functiondef('opc_query(uuid,uuid)'::regprocedure) v")).rows[0].v;
 assert.match(definition,/v3 suggestion withdraw/);assert.match(definition,/D7 read boundary/);
 report.checks.push('actual V3 suggestion creation and withdrawal followed by D7 deletion clears withdrawn body; confirmed content/version/state preserved');
}
