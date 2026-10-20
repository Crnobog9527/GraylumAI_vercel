/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {randomUUID,createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
export const rpc=async(db,name,...args)=>(await db.query(
 `SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
export async function seedActor(db) {
 const actor=randomUUID();
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,1000)',[actor]);
 await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
  idempotency_key,balance_before,balance_after) VALUES($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`,
 [actor,'archive-opening:'+actor]);
 return actor;
}
export async function seedMethod(db) {
 const owner=await seedActor(db),skill=randomUUID(),revision=randomUUID(),module=randomUUID(),model=randomUUID();
 const registration='archive-'+randomUUID();
 await db.query("UPDATE profiles SET role='admin' WHERE id=$1",[owner]);
 await db.query("INSERT INTO skills(id,skill_key,draft_content,created_by) VALUES($1,$2,'',$3)",[skill,registration,owner]);
 const files=[{path:'SKILL.md',content:'---\nname: archive-fixture\ndescription: Local archive test\n---\n# Method\nTest.'},
  {path:'ref.md',content:'Synthetic reference.'}];
 const manifest={packageId:skill,revisionId:revision,directoryName:'archive-fixture',files:files.map(f=>({
  path:f.path,bytes:Buffer.byteLength(f.content),sha256:hash(f.content),mediaType:'text/markdown',requires:[],
 })),tasks:{},requiredCapabilities:[]};
 const payload=JSON.stringify({...manifest,files:manifest.files.map(f=>[f.path,f.bytes,f.mediaType,f.sha256,[]]),tasks:[]});
 manifest.packageHash=hash(payload);
 await rpc(db,'atomic_publish_skill_package',skill,owner,revision,randomUUID(),0,manifest,payload,
  JSON.stringify(files.map(f=>({path:f.path,base64:Buffer.from(f.content).toString('base64')}))));
 await db.query(`INSERT INTO ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit)
  VALUES($1,'Archive test','archive-fixture','fixture','true',1000,32000)`,[model]);
 await db.query("INSERT INTO modules(id,title,skill_id,model_id,active) VALUES($1,'Archive fixture',$2,$3,true)",[module,skill,model]);
 const flow={id:'archive',version:1,kind:'document',steps:[{id:'s',title:'Facts',dependsOn:[],resources:['ref.md'],
  minLength:1,maxLength:20000,requiresEvidence:false,requiredCapabilities:[],
  information:[{id:'goal',title:'Goal',required:true,profileKey:'goal'}]}],
  report:{id:'report',version:1,title:'Report',sections:[{title:'Facts',stepId:'s'}]}};
 await db.query(`INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled)
  VALUES($1,$2,$3,$4,$5,'Archive fixture',true)`,[registration,module,skill,revision,flow]);
 return {owner,skill,revision,module,model,registration};
}
export async function start(db,actor,method,businessId=null,requestId=randomUUID()) {
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,role:'authenticated'})]);
 return rpc(db,'opc_start_b1',actor,requestId,method.registration,'manual',businessId,'Local business','free');
}
