/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// R14 with a fixed revision sample: no review feature, no model call.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,rpc,closeAccount,call,evidence,outcome} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const hash=body=>createHash('sha256').update(body).digest('hex');
const original='## One\nOriginal report.\n## Two\nKnown limitations.';
const revised='## One\nR14_REVISION_PRIVATE_BODY\n## Two\nRevised limitations.';
const info=(value,status='confirmed',nature='fact')=>({status,nature,value});
const field=(id,title,required=true)=>({id,title,required});
const step=(id,title,dependsOn,information)=>({id,title,dependsOn,resources:[],minLength:1,maxLength:20000,
 requiresEvidence:false,requiredCapabilities:[],information});
const body=(fields,values)=>fields.filter(f=>values[f.id]?.value)
 .map(f=>`${f.title}\n${values[f.id].status==='deferred'?'（暂缓确认）':''}${values[f.id].value}`).join('\n\n');
// a -> b (b depends on a); c is independent.
const flow=[step('a','Audience',[],[field('who','Who'),field('pain','Pain',false)]),
 step('b','Offer',['a'],[field('offer','Offer')]),step('c','Voice',[],[field('voice','Voice')])];
const initial={a:{who:info('Busy parents'),pain:info('No time','deferred','hypothesis')},b:{offer:info('Meal plans')},c:{voice:info('Warm')}};

/** A positioning round finalized through R5, so its formal version carries a generated report. */
async function seed(db,maxLength=20000) {
 const base=await fixture(db);
 const f=(await db.query('SELECT d7_test.artifacts($1) v',[base.actor])).rows[0].v;
 const project=randomUUID(),round=randomUUID(),execution=randomUUID(),session=randomUUID();
 const draft=await rpc(db,'bill2_create_draft',f.actor);
 const workflow={id:'r14-fixture',version:1,kind:'document',steps:flow.map(s=>s.id==='a'?{...s,maxLength}:s),
  report:{id:'report',version:1,title:'Positioning',sections:flow.map(s=>({title:s.title,stepId:s.id}))},
  planResources:['report.md'],reportGeneration:{resources:['report.md'],sections:['One','Two'],maxCharacters:12000}};
 const steps={};
 for(const s of flow) steps[s.id]={body:body(s.information,initial[s.id]),version:1,reviewVersion:0,valid:true,
  confirmationId:randomUUID(),evidenceIds:[],provenanceIds:[],information:initial[s.id]};
 await db.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account) VALUES($1,$2,$3,$4,$5)',
  [project,f.actor,f.module,f.skill,'r14-'+project]);
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  VALUES($1,$2,$3,repeat('b',64),$4,repeat('c',64),repeat('d',64),'draft',$5)`,[round,project,f.revision,workflow,steps]);
 for(const [id,st] of Object.entries(steps)) await db.query(`INSERT INTO artifact_confirmations(id,round_id,step_id,version,review_version,body,evidence_ids)
  VALUES($1,$2,$3,1,0,$4,'[]')`,[st.confirmationId,round,id,st.body]);
 await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
  VALUES($1,$2,$3,$4,'{}')`,[session,f.actor,{kind:'positioning_draft',draftId:draft},randomUUID()]);
 await db.query(`INSERT INTO opc_drafts(draft_id,actor_id,project_id,round_id,session_id,request_id,registration,mode)
  VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM artifact_workflows WHERE module_id=$7 LIMIT 1),'mentor')`,
 [draft,f.actor,project,round,session,randomUUID(),f.module]);
 const source=await rpc(db,'report_source',f.actor,session,project,round);
 const spec={version:1,projectId:project,roundId:round,snapshotHash:source.snapshotHash,
  packageHash:'b'.repeat(64),workflowHash:'c'.repeat(64),templateHash:'d'.repeat(64),
  evidenceIds:[],sections:['One','Two'],maxCharacters:12000};
 const context={reportGeneration:spec,request:{sessionId:session},sources:[],network:'deny',role:'skill',
  moduleId:f.module,skillId:f.skill,revisionId:f.revision,packageHash:'b'.repeat(64)};
 const billing={...base.payload,scope:{kind:'positioning_draft',draftId:draft},input:context,
  moduleId:f.module,skillId:f.skill,revisionId:f.revision};
 const run=await rpc(db,'bill2_prepare',f.actor,randomUUID(),billing);
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result,billing_run_id)
  VALUES($1,$2,$3,$4,$5,0,'completed',$6,$7)`,[execution,f.actor,session,randomUUID(),context,{body:original,completeness:'complete'},run.id]);
 await db.query('UPDATE bill2_runs SET session_ref=$1 WHERE id=$2',[session,run.id]);
 const claimed=await call(db,{...base,run:run.id});
 await rpc(db,'bill2_record',f.actor,run.id,claimed.id,evidence(claimed));
 await rpc(db,'bill2_close',f.actor,run.id,'delivered',{...outcome,body:original});
 await rpc(db,'bill2_finalize',f.actor,run.id);
 const formal=await rpc(db,'report_document',f.actor,execution,'finalize',randomUUID(),0,null,hash(original));
 assert.equal(formal.version,1);
 return {...f,project,round,session,draft,execution,base,versionId:formal.versionId};
}
const proposal={a:{who:'Busy working parents',pain:'No time'},c:{voice:'Warm'}};
const call14=(db,f,action,{request=randomUUID(),revision=null,version=f.versionId,text=revised,fields=proposal,diffHash=null}={})=>
 rpc(db,'report_revision',f.actor,f.draft,action,request,revision,version,text,fields,diffHash);
const propose=(db,f,opts={})=>call14(db,f,'propose',opts);
const apply=(db,f,rv,opts={})=>call14(db,f,'apply',{revision:rv.revisionId,diffHash:rv.diffHash,...opts});
const decline=(db,f,rv,opts={})=>call14(db,f,'decline',{revision:rv.revisionId,...opts});
const current=async(db,f)=>(await db.query(`SELECT p.current_version,d.round_id,r.steps,r.state FROM artifact_projects p
 JOIN opc_drafts d ON d.project_id=p.id JOIN artifact_rounds r ON r.id=d.round_id WHERE p.id=$1`,[f.project])).rows[0];

export async function runCases({db,Client,connectionString,report}) {
 for(const role of ['anon','authenticated']) {
  await db.query('SET ROLE '+role);
  await assert.rejects(rpc(db,'report_revision',randomUUID(),randomUUID(),'read',null,null,null,null,null,null),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 await assert.rejects(db.query(`SELECT report_revision_snapshot($1,$2,$3,'{}','{}')`,[randomUUID(),randomUUID(),randomUUID()]),/permission denied/);
 await assert.rejects(db.query(`SELECT report_revision_diff(NULL::artifact_rounds,'{}')`),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('public roles denied; service_role cannot invoke private helpers');

 const f=await seed(db);
 const before=await current(db,f);
 const request=randomUUID();
 const rv=await propose(db,f,{request});
 assert.equal(rv.decision,null);assert.equal(rv.bodyHash,hash(revised));
 assert.deepEqual(rv.diff.changes.map(c=>[c.stepId,c.fieldId,c.before.value,c.before.status,c.after.value]),
  [['a','who','Busy parents','confirmed','Busy working parents'],['a','pain','No time','deferred','No time']]);
 assert.deepEqual(rv.diff.cascade.map(c=>[c.stepId,c.fields.map(x=>[x.fieldId,x.before.value,x.after.value])]),
  [['b',[['offer','Meal plans','Meal plans']]]],'dependent step listed with its values; unchanged independent step omitted');
 assert.deepEqual(await propose(db,f,{request}),rv,'replay returns the same revision');
 await assert.rejects(propose(db,f,{request,text:original}),/REPORT_REQUEST_CONFLICT/);
 assert.deepEqual(await current(db,f),before,'proposing changes nothing');
 report.checks.push('diff lists changed fields (value and deferred-to-confirmed) and dependent steps; replay stable; same id with new content refused');

 for(const [fields,pattern] of [[{a:{nope:'x'}},/REPORT_REVISION_INVALID/],[{z:{who:'x'}},/REPORT_REVISION_INVALID/],
  [{a:{who:'   '}},/REPORT_REVISION_INVALID/],[{a:{who:'x'.repeat(401)}},/REPORT_REVISION_INVALID/],[{a:{who:1}},/REPORT_REVISION_INVALID/],
  ['[]',/REPORT_REVISION_INVALID/]]) await assert.rejects(propose(db,f,{fields}),pattern);
 await assert.rejects(propose(db,f,{text:'## One\nOnly one section.'}),/REPORT_NOT_COMPLETE/);
 await assert.rejects(propose(db,f,{version:randomUUID()}),/REPORT_REVISION_STALE/);
 const foreign=await fixture(db);
 await assert.rejects(propose(db,{...f,actor:foreign.actor}),/REPORT_REVISION_DENIED/);
 await assert.rejects(call14(db,{...f,actor:foreign.actor},'read',{revision:rv.revisionId}),/REPORT_REVISION_DENIED/);
 report.checks.push('unknown step/field, empty, over-long or non-text values, malformed body, non-current version and other users refused');

 await assert.rejects(apply(db,f,rv,{diffHash:'0'.repeat(64)}),/REPORT_REVISION_STALE/);
 // Forged publication: a revision round outside report_revision cannot use the revision text.
 const forged=randomUUID();
 await db.query('BEGIN');
 try {
  await rpc(db,'opc_revise',f.actor,f.draft,forged,before.round_id);
  await assert.rejects(rpc(db,'artifact_transition',f.actor,f.module,f.skill,'publish',f.project,forged,randomUUID(),
   {reviewRevisionId:rv.revisionId}),/REPORT_EXECUTION_REQUIRED/);
 } finally {await db.query('ROLLBACK');}
 report.checks.push('wrong diff hash refused; publication with the revision outside its own transaction refused');

 const applyRequest=randomUUID();
 const done=await apply(db,f,rv,{request:applyRequest});
 assert.equal(done.decision,'applied');assert.equal(done.fieldsSynced,true);assert.equal(done.version,2);
 assert.deepEqual(done.next,{kind:'first_week_topics',draftId:f.draft,sourceVersionId:done.versionId});
 const after=await current(db,f);
 assert.equal(after.current_version,2);assert.equal(after.state,'published');assert.notEqual(after.round_id,before.round_id);
 assert.deepEqual(after.steps.a.information.who,{status:'confirmed',nature:'fact',value:'Busy working parents'});
 assert.deepEqual(after.steps.a.information.pain,{status:'confirmed',nature:'hypothesis',value:'No time'});
 assert.equal(after.steps.a.fieldMeta.who.source,'revision');assert.equal(after.steps.a.fieldMeta.pain.source,'revision');
 assert.equal(after.steps.a.body,'Who\nBusy working parents\n\nPain\nNo time');
 assert.deepEqual(after.steps.b.information,initial.b);assert.deepEqual(after.steps.c.information,initial.c);
 assert.equal(after.steps.c.fieldMeta,undefined,'unchanged step keeps no revision marker');
 for(const k of ['a','b','c']) assert.equal(after.steps[k].valid,true);
 const formal=(await db.query('SELECT report FROM artifact_versions WHERE id=$1',[done.versionId])).rows[0].report;
 assert.equal(formal.generatedReport.source,'review_revision');assert.equal(formal.generatedReport.fieldsSynced,true);
 assert.equal(formal.generatedReport.body,revised);assert.equal(formal.generatedReport.sourceVersionId,f.versionId);
 assert.equal(formal.sections.find(s=>s.stepId==='a').body,'Who\nBusy working parents\n\nPain\nNo time');
 const old=(await db.query('SELECT report FROM artifact_versions WHERE id=$1',[f.versionId])).rows[0].report;
 assert.equal(old.generatedReport.body,original,'the earlier formal version is kept');
 assert.equal(await rpc(db,'opc_source_allowed',f.actor,done.versionId),true);
 assert.equal((await rpc(db,'opc_topic_consent',f.actor,f.draft,done.versionId)).sourceVersionId,done.versionId);
 assert.deepEqual(await apply(db,f,rv,{request:applyRequest}),done,'apply replay');
 await assert.rejects(apply(db,f,rv),/REPORT_REVISION_DECIDED/);
 await assert.rejects(decline(db,f,rv),/REPORT_REVISION_DECIDED/);
 await assert.rejects(propose(db,f),/REPORT_REVISION_STALE/,'the old version is no longer current');
 assert.deepEqual(await call14(db,f,'read',{revision:rv.revisionId}),done);
 report.checks.push('apply: new current version, changed fields confirmed with revision source, dependent step re-confirmed, report text is the revision, old version kept, topics follow the new version; replay stable; second decision refused');

 const g=await seed(db);
 const gBefore=await current(db,g);
 const grv=await propose(db,g);
 const declined=await decline(db,g,grv);
 assert.equal(declined.decision,'declined');assert.equal(declined.fieldsSynced,false);assert.equal(declined.versionId,null);
 assert.deepEqual(await current(db,g),gBefore,'decline leaves fields, round and version unchanged');
 assert.deepEqual(await call14(db,g,'latest'),declined);
 await assert.rejects(apply(db,g,grv),/REPORT_REVISION_DECIDED/);
 report.checks.push('decline: fields, formal version and round unchanged; revision kept as text with fieldsSynced=false; apply afterwards refused');

 const h=await seed(db);
 const first=await propose(db,h),second=await propose(db,h,{fields:{c:{voice:'Direct'}}});
 await apply(db,h,second);
 await assert.rejects(apply(db,h,first),/REPORT_REVISION_STALE/,'a revision of a superseded version cannot apply');
 const race=await seed(db);const rr=await propose(db,race);
 const other=new Client({connectionString});await other.connect();
 try {
  const outcomes=await Promise.allSettled([apply(db,race,rr),apply(other,race,rr)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String(outcomes.find(x=>x.status==='rejected').reason),/REPORT_REVISION_DECIDED/);
  const mixed=await seed(db);const mr=await propose(db,mixed);
  const both=await Promise.allSettled([apply(db,mixed,mr),decline(other,mixed,mr)]);
  assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String(both.find(x=>x.status==='rejected').reason),/REPORT_REVISION_DECIDED/);
  assert.equal((await db.query('SELECT count(*) n FROM artifact_versions WHERE project_id=$1',[race.project])).rows[0].n,'2');
 } finally {await other.end();}
 report.checks.push('superseded version refused; two concurrent applies and apply/decline races yield exactly one decision');

 // Step a accepts at most 60 characters: the revised value fits the field limit but not the step.
 const broken=await seed(db,60);const br=await propose(db,broken,{fields:{a:{who:'x'.repeat(80)}}});
 const brokenBefore=await current(db,broken);
 await assert.rejects(apply(db,broken,br),/REPORT_SOURCE_CONFLICT/);
 assert.deepEqual(await current(db,broken),brokenBefore,'failed apply rolls back every write');
 assert.equal((await db.query('SELECT count(*) n FROM artifact_rounds WHERE project_id=$1',[broken.project])).rows[0].n,'1');
 assert.equal((await call14(db,broken,'read',{revision:br.revisionId})).decision,null,'no decision recorded');
 report.checks.push('a confirmation failure inside apply rolls back the new round and version');

 await erase(db,f,'artifact',f.project);
 await assert.rejects(call14(db,f,'read',{revision:rv.revisionId}),/CONTENT_ERASED/);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload,response FROM artifact_requests WHERE project_id=$1',[f.project])).rows),
  /R14_REVISION_PRIVATE_BODY/);
 assert.equal((await db.query('SELECT report FROM artifact_versions WHERE id=$1',[done.versionId])).rows[0].report,null);
 report.checks.push('artifact deletion scrubs revision text, decisions and the revised formal report without changing erasure functions');
 await closeAccount(db,g.base);
 await rpc(db,'account_erasure_scrub_content',g.actor);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload,response FROM artifact_requests WHERE project_id=$1',[g.project])).rows),
  /R14_REVISION_PRIVATE_BODY/);
 await assert.rejects(call14(db,g,'latest'),/ACTOR_DENIED|CONTENT_ERASED|REPORT_REVISION_DENIED/);
 report.checks.push('account erasure scrubs declined revision text and denies future reads');
}
