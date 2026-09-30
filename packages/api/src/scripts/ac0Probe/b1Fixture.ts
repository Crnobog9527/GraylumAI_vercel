/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// B1-only local storage ports. No remote database, configuration, or product writes.
import {randomUUID} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {AgentInputItem} from '@openai/agents';
import {runtimeAdmissionService} from '../../services/runtime/admission';
import {PostgresSession} from '../../services/runtime/session';
import {agentTurnInstructions} from '../../services/opc/agentTurnPrompt';
import {packageHash, sha256} from '../../services/skills/loader';
import {openRouterBound} from '../../services/bill2/openRouterPolicy';
import type {LoadedSkill, Scenario} from './skill.ts';

export const B1_MODEL = 'anthropic/claude-sonnet-5.5';
export const B1_MAX_TOKENS = 4096;
export const B1_REQUEST_BYTE_STOP = 100000;

/** Actual admission and Skill loader, backed only by isolated in-memory ports.
 * Recreates each PostgresSession with the same sessionId across the two runs.
 * Model/route/reasoning/output are the frozen PLAN 14.7-14.8 selection.
 */
export function b1Fixture(skill:LoadedSkill, scenario:Scenario) {
  const actorId=randomUUID(), sessionId=randomUUID(), modelId=randomUUID();
  const moduleId=randomUUID(), skillId=randomUUID(), revisionId=randomUUID();
  const files=new Map([['SKILL.md',skill.instructions],...skill.references]);
  const directoryName=/^name:\s*(.+)$/m.exec(skill.instructions)?.[1]?.trim();
  if(!directoryName)throw new Error('B1_SKILL_NAME_REQUIRED');
  const descriptorBase={packageId:skillId,revisionId,directoryName,tasks:{},requiredCapabilities:[],
    files:[...files].map(([path,text])=>({path,bytes:Buffer.byteLength(text),sha256:sha256(text),
      mediaType:(path.endsWith('.md')?'text/markdown':'text/yaml') as 'text/markdown'|'text/yaml',requires:[]}))};
  const descriptor={...descriptorBase,packageHash:packageHash(descriptorBase)};
  const limits={providerSlug:'anthropic',contextTokens:1000000,
    promptUsdPerMillion:'2',completionUsdPerMillion:'10',requestUsd:'0'};
  const quote={modelId,model:B1_MODEL,provider:'openrouter' as const,account:'b1-local-test',
    protocol:'openrouter-chat-v1' as const,providerLimits:limits,
    upperUsd:openRouterBound(limits,B1_MAX_TOKENS).upperUsd,inputLimit:1000000,outputLimit:B1_MAX_TOKENS,
    automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
  const model={id:modelId,model_id:B1_MODEL,provider:'openrouter',is_active:'true',
    input_limit:1000000,max_tokens:B1_MAX_TOKENS,config:{reasoning:{route:'anthropic',
      catalog:{fetchedAt:'2026-09-30T00:00:00Z',model:B1_MODEL,
        reasoning:{mandatory:true,defaultEnabled:true,supportedEfforts:['low'],defaultEffort:'low',supportsMaxTokens:false},
        endpoints:[{tag:'anthropic',providerName:'Anthropic',supportedParameters:['tools','reasoning_effort'],
          contextLength:1000000,maxCompletionTokens:128000}]},
      purposes:{interactive:{mode:'effort',effort:'low',wire:'reasoning_effort'}}}}};
  // The selected B1 scenarios contain only user background; no synthetic assistant/tool chain is seeded.
  if(scenario.history.some(item=>item.role!=='user'))throw new Error('B1_SYNTHETIC_ASSISTANT_HISTORY_DENIED');
  const items:AgentInputItem[]=scenario.history.map(item=>({role:'user',content:item.content!}));
  const rpc=async(name:string,args:Record<string,unknown>)=>{
    let data:unknown;
    if(name==='runtime_session_context')data={scope:{kind:'positioning_draft',draftId:sessionId}};
    else if(name==='runtime_admission_replay')data=null;
    else if(name==='runtime_admit')data={executionId:args.p_request_id,context:args.p_payload,billing:args.p_billing};
    else if(name==='read_skill_package'){
      data=args.p_path===null?descriptor:args.p_path===''?true:
        Buffer.from(files.get(String(args.p_path))??'').toString('base64');
    }else if(name==='runtime_session_items'){
      if(args.p_session_id!==sessionId||args.p_actor_id!==actorId)throw new Error('B1_SESSION_BINDING');
      if(args.p_action==='append'){items.push(...structuredClone(args.p_items as AgentInputItem[]));data=true;}
      else if(args.p_action==='freeze')data=true;
      else if(args.p_action==='read'){
        const rows=items.map((item,i)=>({revision:i+1,item:structuredClone(item)}));
        data=args.p_limit===null?rows:args.p_limit===0?[]:rows.slice(-Number(args.p_limit));
      }else throw new Error('B1_SESSION_ACTION');
    }else throw new Error('B1_UNEXPECTED_RPC:'+name);
    return {data,error:null};
  };
  const from=(table:string)=>{
    const row=table==='modules'?{id:moduleId,active:true,skill_id:skillId,model_id:modelId}:
      table==='ai_models'?model:null;
    if(!row)throw new Error('B1_UNEXPECTED_TABLE:'+table);
    const query={select:()=>query,eq:()=>query,single:async()=>({data:row,error:null})};
    return query;
  };
  const user={from,auth:{getUser:async()=>({data:{user:{id:actorId,email_confirmed_at:'2026-01-01'}},error:null})}};
  const current=skill.workflow?.[scenario.step!];
  const question=current?.information?.find(field=>field.id===scenario.questionId);
  if(!current||!question)throw new Error('B1_SCENARIO_CONTEXT_REQUIRED');
  // Reuse the unchanged production host builder and existing scenario context.
  const additionalInstructions=agentTurnInstructions({
    step:{id:scenario.currentStepId!,title:current.title,schema:current.information??[],values:scenario.fieldValues},
    question,questionLabel:null,opening:false,
    workflowContext:skill.workflow?.map((step,index)=>({index,title:step.title,information:step.information??[]})),
  });
  const admission=runtimeAdmissionService(user as unknown as SupabaseClient,{rpc,from} as unknown as SupabaseClient,{
    account:quote.account,costPerCall:quote.upperUsd,creditsPerUsd:'1000',multiplier:'1',
    maxCalls:1,maxOutputTokens:B1_MAX_TOKENS,inputBytes:1000000,historyItems:100,
    mentorStream:true,opcTurnToken:randomUUID(),additionalInstructions,skillResources:current.resources,
    real:{id:randomUUID(),creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01T00:00:00Z',callPolicies:[quote]},
  });
  return {quote,sessionId,items,
    async admit(input:string){
      const result=await admission.prepare({sessionId,requestId:randomUUID(),input,network:'deny',organizeAfter:false,
        selection:{kind:'skill',moduleId,revisionId}});
      return {...result,session:new PostgresSession({rpc},{actorId,sessionId,executionId:result.executionId})};
    },
  };
}
