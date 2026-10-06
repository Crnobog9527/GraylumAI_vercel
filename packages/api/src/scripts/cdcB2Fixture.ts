/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import pg from 'pg';
import {saveModuleSkill,type ModuleSkillInput} from '../services/skills/modulePublication.ts';
import {opcService} from '../services/opc/service.ts';
import {pricingConfig} from '../services/__tests__/fixtures/runtimePricing.ts';
import {EXPIRES,profiles,quote,type Role} from '../../../../scripts/cdc-b2-eval/policy.ts';
export async function fixture(input:ModuleSkillInput){
 const connectionString=process.env.V3_LOCAL_DB!;
 if(!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/v3_disposable$/.test(connectionString)||
  !process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:'))throw new Error('CDC_DISPOSABLE_ONLY');
 const db=new pg.Client({connectionString});await db.connect();
 const admin=createClient(process.env.V3_LOCAL_REST,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
 const credential={email:randomUUID()+'@example.test',password:randomUUID()};
 const created=await admin.auth.admin.createUser({...credential,email_confirm:true});
 if(created.error)throw new Error('CDC_LOCAL_USER');const actor=created.data.user.id;
 await db.query("insert into profiles(id,role,credits) values($1,'admin',1000000)",[actor]);
 await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
  idempotency_key,balance_before,balance_after) values($1,1000000,'addition','grant','opening_grant','system',$2,0,1000000)`,[actor,randomUUID()]);
 const user=createClient(process.env.V3_LOCAL_REST,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 if((await user.auth.signInWithPassword(credential)).error)throw new Error('CDC_LOCAL_LOGIN');
 const ids={mentor:randomUUID(),organizer:randomUUID()};
 for(const role of ['mentor','organizer'] as Role[]){
  const p=profiles[role],config=pricingConfig(p.model,p.route,p.prompt,p.completion);
  config.reasoning.catalog.reasoning={mandatory:false,defaultEnabled:true,supportedEfforts:['low'],defaultEffort:'low',supportsMaxTokens:false};
  config.reasoning.catalog.endpoints[0]!.supportedParameters=['tools','reasoning_effort'];
  config.reasoning.purposes=role==='mentor'?{interactive:{mode:'effort',effort:'low',wire:'reasoning_effort'}}:{organize:{mode:'provider_default'}};
  await db.query(`insert into ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint,max_tokens,input_limit,config)
   values($1,'CDC local model',$2,'openai','true','LOCAL_BOUNDARY_ONLY','https://openrouter.ai/api/v1',$3,$4,$5)`,
   [ids[role],p.model,p.output,p.context,config]);
 }
 const settings={v3_summary_model_id:ids.organizer,v3_summary_max_tokens:2048,billing_credits_per_usd:'100',billing_token_price_multiplier:'3',
  runtime_purpose_budgets:{version:2,interactive:{inputBytes:90000,historyItems:100},organize:{inputBytes:64000,historyItems:0},
   report:{inputBytes:196608,historyItems:0}}};
 for(const [key,value] of Object.entries(settings))await db.query(
  'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',[key,JSON.stringify(value)]);
 const policies=(['mentor','organizer'] as Role[]).map(role=>({...quote(role,ids[role]),multiplier:'3'}));
 const window=randomUUID();
 await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,
  max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,100,3,9,100,$4)`,[window,[actor],JSON.stringify(policies),EXPIRES]);
 // Only this disposable process; the loopback clients above remain the sole database transports.
 Object.assign(process.env,{V3_RUNTIME_STAGING_PROJECT_ID:'cdc-local',VERCEL_PROJECT_ID:'cdc-local',VERCEL:'1',
  VERCEL_PROJECT_PRODUCTION_URL:'auth-staging.graylum.com',VERCEL_GIT_COMMIT_REF:'staging',VERCEL_GIT_REPO_OWNER:'Crnobog9527',
  VERCEL_GIT_REPO_SLUG:'GraylumAI_vercel',NEXT_PUBLIC_SUPABASE_URL:'https://cdclocal.supabase.co',
  V3_RUNTIME_STAGING_DATABASE_HOST:'cdclocal.supabase.co',V3_RUNTIME_STAGING_WINDOW_ID:window,V3_RUNTIME_STAGING_ENABLED:'true'});
 const module={...input,moduleId:randomUUID(),skillId:randomUUID(),revisionId:randomUUID(),requestId:randomUUID(),
  expectedUpdatedAt:null,expectedVersion:0,module:{...input.module,model_id:ids.mentor}};
 await saveModuleSkill(admin,actor,module);
 const registration=(await db.query('select id from artifact_workflows where module_id=$1',[module.moduleId])).rows[0].id;
 const real={id:window,callPolicies:policies,creditsPerUsd:'100',multiplier:'3',expiresAt:EXPIRES};
 return {db,admin,user,actor,registration,module,service:opcService(user,admin,real)};
}
