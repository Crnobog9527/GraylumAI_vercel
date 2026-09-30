/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Standalone B1 protocol measurement. Application code must never import this module.
import {runRuntime} from '../../services/runtime/runner';
import {openRouterRequestBody} from '../../services/runtime/providerRequest';
import {projectOpenRouterItemsForSizing} from '../../services/runtime/openRouterHistory';
import {selectRuntimeHistory,selectRuntimeCallInput,assertRuntimeRequestCapacity} from '../../services/runtime/context';
import {askQuestionTool,askQuestionToolBytes,questionCardFromResult,AGENT_TOOL_NAMES} from '../../services/runtime/agentTools';
import {openRouterAdapter} from '../../services/bill2/openRouterAdapter';
import {decodeOpenRouterStreamObservation} from '../../services/bill2/openRouterEvidence';
import type {TransportObservation} from '../../services/bill2/fixtureAdapter';
import {b1Fixture,B1_MAX_TOKENS,B1_REQUEST_BYTE_STOP} from './b1Fixture.ts';
import {AGENT_TURN_CANDIDATES} from './agentTurn.ts';
import {callBoundUsd} from './config.ts';
import {usdToNano,type Budget} from './budget.ts';
import type {LoadedSkill,Scenario} from './skill.ts';

export type B1Message={role:string;content?:unknown;
  tool_calls?:Array<{id:string;function:{arguments:string;name?:string}}>};
export type B1Request={model:string;messages:B1Message[];max_tokens:number;reasoning_effort:string};
type B1Response={choices?:Array<{message?:B1Message;finish_reason?:string}>;
  usage?:{prompt_tokens:number;completion_tokens:number;completion_tokens_details?:{reasoning_tokens?:number};[key:string]:unknown}};

export type B1Turn={turn:number;request?:string;sdkRequest?:string;history?:unknown[];httpStatus?:number;
  normalization:'not_reached'|'accepted'|'denied';error?:string;observation?:TransportObservation;
  response?:B1Response;card?:boolean;toolArgumentChars?:number;toolArgumentCodePoints?:number;
  bookedUsd?:number;providerCostUsd?:number;boundUsd?:number;requestBytes?:number;
  reasoning?:{hasPayload:boolean;detailTypes:string[];hasSignature:boolean;reportedTokens?:number};
  state:'not_sent'|'sent'|'complete'|'provider_rejected'|'history_denied'|'unknown'|'local_error';
};
/** Only an observed, complete SSE error frame proves a provider rejection.
 * The product adapter deliberately cancels the reader after that frame.
 */
function explicitStreamError(observation:TransportObservation):string|undefined{
  if(!observation.stream||observation.transportIssue!=='provider_stream_error')return;
  const wire=decodeOpenRouterStreamObservation(observation).toString('utf8');
  for(const frame of wire.replaceAll('\r\n','\n').split('\n\n').slice(0,-1)){
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    try{const value=JSON.parse(data);
      if(value?.error&&typeof value.error==='object'&&
        (typeof value.error.message==='string'||value.error.code!==undefined))return data;
    }catch{/* partial or non-JSON data is not proof of a rejection */}
  }
}

/** Inspect the retained wire, not the SDK projection that discards reasoning. */
function reasoningEvidence(observation:TransportObservation,reportedTokens:number|undefined){
  let hasPayload=false,hasSignature=false;
  const detailTypes=new Set<string>();
  const wire=decodeOpenRouterStreamObservation(observation).toString('utf8');
  for(const frame of wire.replaceAll('\r\n','\n').split('\n\n').slice(0,-1)){
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    try{
      const value=JSON.parse(data);
      for(const choice of value.choices??[]){
        const delta=choice.delta??{};
        if(typeof delta.reasoning==='string'&&delta.reasoning.trim())hasPayload=true;
        for(const detail of Array.isArray(delta.reasoning_details)?delta.reasoning_details:[]){
          if(typeof detail.type==='string')detailTypes.add(detail.type);
          if(typeof detail.signature==='string'&&detail.signature.length>0)hasSignature=true;
          if(['text','summary','data'].some(key=>typeof detail[key]==='string'&&detail[key].trim()))hasPayload=true;
        }
      }
    }catch{/* Non-JSON frames do not prove reasoning content. */}
  }
  return {hasPayload,detailTypes:[...detailTypes],hasSignature,reportedTokens};
}

export type B1Pair={scenarioId:string;turns:B1Turn[];secondInput?:string;
  prerequisiteMissing?:'card'|'reasoning_payload';
  verdict:'PASS'|'FAIL'|'UNKNOWN'|'PREREQUISITE_NOT_MET'|'NOT_RUN';};

/** Each actual network request is owned by the production adapter. The hook only
 * reserves the existing AC0 ledger and saves evidence; it never changes bytes.
 */
export async function runB1Pair(options:{skill:LoadedSkill;scenario:Scenario;budget:Budget;
  transport:typeof fetch;requireReasoning?:boolean;credential:()=>Promise<string>;save:(pair:B1Pair)=>void}){
  const fixture=b1Fixture(options.skill,options.scenario);
  const pair:B1Pair={scenarioId:options.scenario.id,turns:[],verdict:'NOT_RUN'};
  let input=options.scenario.input;
  for(let turn=1;turn<=2;turn++){
    const record:B1Turn={turn,normalization:'not_reached',state:'not_sent'};
    pair.turns.push(record);options.save(pair);
    let settle:ReturnType<Budget['reserve']>|undefined;
    try{
      const admitted=await fixture.admit(input),context=admitted.context;
      if(context.providerRequestFormat!=='agent-turn-v5-stream'||context.reasoning?.effort!=='low'||
        context.maxOutputTokens!==B1_MAX_TOKENS||context.maxTurns!==1||context.attachedOrganizer||
        JSON.stringify(context.tools)!==JSON.stringify(['ask_question']))throw new Error('B1_FROZEN_CONTEXT_MISMATCH');
      const adapter=openRouterAdapter({allowAgentTools:true,credential:options.credential,
        transport:async(url,init)=>{
          if(String(url)!=='https://openrouter.ai/api/v1/chat/completions'||init?.method!=='POST')
            throw new Error('B1_NETWORK_TARGET_DENIED');
          if(record.state!=='not_sent'||String(init.body)!==record.request)throw new Error('B1_REDISPATCH_DENIED');
          record.requestBytes=Buffer.byteLength(String(init.body));
          assertRuntimeRequestCapacity(String(init.body),B1_REQUEST_BYTE_STOP);
          record.boundUsd=callBoundUsd(AGENT_TURN_CANDIDATES.c3,record.requestBytes,B1_MAX_TOKENS);
          settle=options.budget.reserve(usdToNano(record.boundUsd));
          record.bookedUsd=record.boundUsd;record.state='sent';options.save(pair);
          try{return await options.transport(url,init);}
          catch(error){record.error=(error as Error).message;options.save(pair);throw error;}
        }});
      let selectedHistoryCount=0;
      const sizing={projectItemsForSizing:(items:unknown[],count:number)=>{
        try{return projectOpenRouterItemsForSizing(items,count,AGENT_TOOL_NAMES);}
        catch(error){record.error=(error as Error).message;throw error;}
      }};
      const common={instructions:context.instructions,inputBytes:fixture.quote.inputLimit,
        toolBytes:askQuestionToolBytes(),...sizing};
      const result=await runRuntime({...context,session:admitted.session,stream:true,tools:[askQuestionTool()],
        allowEmptyResult:true,commitSessionOnSuccess:true,firstToolCallOnly:true,stopAtToolNames:['ask_question'],
        selectHistory:async(history,incoming)=>{
          record.history=structuredClone(history);
          const selected=selectRuntimeHistory(history,incoming,{...common,historyItems:context.historyItems});
          selectedHistoryCount=selected.length-incoming.length;
          await admitted.session.freezeHistoryItems(selected.slice(0,selectedHistoryCount));return selected;
        },
        filterModelInput:(items,instructions)=>selectRuntimeCallInput(items,selectedHistoryCount,
          {...common,instructions,preserveHistoricalMaterial:false}) as typeof items,
        exchange:async(_sequence,body,onChunk)=>{
          record.sdkRequest=body;
          try{
            record.request=openRouterRequestBody(body,{context,policy:fixture.quote,phase:'skill',primaryDialogue:true});
            record.normalization='accepted';
          }catch(error){record.normalization='denied';record.error=(error as Error).message;throw error;}
          const sent: B1Request=JSON.parse(record.request);
          if(turn===2){
            const first=pair.turns[0]!.response?.choices?.[0]?.message?.tool_calls?.[0];
            const assistant=sent.messages.find(m=>m.role==='assistant'&&m.tool_calls?.[0]?.id===first?.id);
            if(!first||!assistant||assistant.tool_calls?.[0]?.function.arguments!==first.function.arguments||
              sent.messages.at(-1)?.content!==pair.secondInput)throw new Error('B1_REAL_TOOL_HISTORY_MISSING');
          }
          options.save(pair);
          const send=await adapter.prepareDispatch({input:record.request},fixture.quote,onChunk);
          const observation=await send();record.observation=observation;record.httpStatus=observation.httpStatus;
          const evidence=adapter.evidence(observation,fixture.quote,'response');
          const response=evidence.usage?.sdkResponse as B1Response|undefined;
          record.response=response;
          if(observation.stream)record.reasoning=reasoningEvidence(observation,response?.usage?.completion_tokens_details?.reasoning_tokens);
          const rawArgs=response?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
          if(typeof rawArgs==='string'){
            record.toolArgumentChars=rawArgs.length;record.toolArgumentCodePoints=[...rawArgs].length;
          }
          if(evidence.cost!==null&&evidence.cost!==undefined)record.providerCostUsd=Number(evidence.cost);
          const streamError=explicitStreamError(observation);
          if(streamError){record.state='provider_rejected';record.error=streamError;throw new Error('B1_PROVIDER_REJECTED');}
          if(!observation.complete){record.state='unknown';throw new Error(observation.transportIssue??'B1_INCOMPLETE_RESPONSE');}
          if(observation.httpStatus<200||observation.httpStatus>=300){
            record.state='provider_rejected';
            record.error=observation.stream?decodeOpenRouterStreamObservation(observation).toString('utf8'):observation.rawBody;
            throw new Error('B1_PROVIDER_REJECTED');
          }
          if(!response){record.state='unknown';throw new Error('B1_RESPONSE_UNRESOLVED');}
          const usage=response.usage;
          // Same conservative settlement rule as ac0Probe: never assume absent cost is zero.
          if(record.providerCostUsd!==undefined&&usage&&Number.isFinite(usage.prompt_tokens)&&Number.isFinite(usage.completion_tokens)){
            record.bookedUsd=Math.max(record.providerCostUsd,(usage.prompt_tokens*2+usage.completion_tokens*10)/1e6);
            settle!(usdToNano(record.bookedUsd));
          }
          record.state='complete';options.save(pair);return JSON.stringify(response);
        },
      });
      const card=questionCardFromResult(result);record.card=Boolean(card);
      const args=record.response?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if(typeof args==='string'){record.toolArgumentChars=args.length;record.toolArgumentCodePoints=[...args].length;}
      if(turn===1){
        if(!card){pair.verdict='PREREQUISITE_NOT_MET';pair.prerequisiteMissing='card';options.save(pair);break;}
        if(options.requireReasoning&&!record.reasoning?.hasPayload){
          pair.verdict='PREREQUISITE_NOT_MET';pair.prerequisiteMissing='reasoning_payload';options.save(pair);break;
        }
        pair.secondInput=card.options[0]!;input=pair.secondInput;
      }else pair.verdict='PASS';
    }catch(error){
      record.error??=(error as Error).message;
      if(record.error==='RUNTIME_PROVIDER_HISTORY_DENIED'){
        record.state='history_denied';record.normalization='denied';pair.verdict=turn===2?'FAIL':'PREREQUISITE_NOT_MET';
      }else if(record.state==='provider_rejected')pair.verdict=turn===2?'FAIL':'PREREQUISITE_NOT_MET';
      else if(record.state==='sent'||record.state==='unknown'){
        record.state='unknown';pair.verdict='UNKNOWN';options.budget.stop('B1_UNKNOWN_RESULT');
      }else{record.state='local_error';pair.verdict='NOT_RUN';options.budget.stop('B1_LOCAL_ERROR');}
      options.save(pair);break;
    }
    options.save(pair);
  }
  return pair;
}
