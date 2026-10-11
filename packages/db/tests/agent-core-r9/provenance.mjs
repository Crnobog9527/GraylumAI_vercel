/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';
import {erase,preview} from '../content-erasure/cases.mjs';
export async function runProvenance(db,report,basis='user_statement'){
 const f=(await db.query('SELECT runtime_perf_test.seed(0,false) v')).rows[0].v;
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const project=randomUUID(),round=randomUUID();
 const workflow={steps:[{id:'s',information:[{id:'goal'},{id:'auto'}]}]};
 const steps={s:{version:7,valid:false,information:{goal:{value:'KEEP_CONFIRMED',status:'confirmed',nature:'fact'},auto:{value:'',status:'unknown',nature:'unknown'}},
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
 const executions=Array.from({length:1},()=>({id:randomUUID(),request_id:randomUUID()})).sort((a,b)=>a.id.localeCompare(b.id));
 const suggestion={value:'V3_PRIVATE_SUGGESTION',nature:'fact',basis};
 for(let i=0;i<executions.length;i++){
  const e=executions[i],token=randomUUID();
  const input={captureFormat:'v2',userInput:i?'撤回之前的建议':'请更新目标',
   checklist:[{id:'s',fields:[{id:'goal',...(i?{pendingSuggestion:suggestion}:{})}]}]};
  const output={inputKind:'request',patches:[{stepId:'s',fieldId:'goal',status:'provisional',...suggestion},{stepId:'s',fieldId:'auto',status:'provisional',...suggestion}],notes:[],
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
  else assert.equal(applied.result,'applied');
 }
 const before=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.equal(before.s.fieldMeta.auto.executionId,executions[0].id);
 assert.equal(before.s.fieldMeta.auto.basis,basis);assert.ok(before.s.fieldMeta.auto.createdAt);
 const pending=before.s.fieldMeta.goal.suggestion;
 assert.ok(pending.createdAt);
 await rpc(db,'opc_capture_resolve',f.actor,f.draft,randomUUID(),'s','goal',executions[0].id,pending.hash,'accept',8);
 const accepted=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.equal(accepted.s.fieldMeta.goal.executionId,executions[0].id);
 assert.equal(accepted.s.fieldMeta.goal.basis,basis);assert.ok(accepted.s.fieldMeta.goal.acceptedAt);
 const values={...accepted.s.information,goal:{value:'USER_INDEPENDENT_EDIT',status:'confirmed',nature:'decision'}};
 await rpc(db,'opc_information',f.actor,f.draft,'s',randomUUID(),9,values);
 const manual=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.equal(manual.s.fieldMeta.goal.executionId,undefined);
 assert.equal(manual.s.fieldMeta.goal.basis,'user_statement');
 assert.equal(manual.s.fieldMeta.goal.origin.executionId,executions[0].id);
 const frozen=await rpc(db,'runtime_work_projection',f.actor,f.session,round);
 assert.match(JSON.stringify(frozen),new RegExp(executions[0].id));
 await erase(db,f,'answer',executions[0].id);
 const after=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.equal(after.s.information.auto.value,'');
 assert.equal(after.s.information.goal.value,'USER_INDEPENDENT_EDIT');
 assert.equal(after.s.fieldMeta.goal.origin,undefined);
 assert.equal(after.s.fieldMeta.goal.sourceAvailable,false);
 report.checks.push(basis+': real capture/accept/manual/freeze preserves provenance; D7 clears automatic content and source metadata but keeps independent user edit');
}
