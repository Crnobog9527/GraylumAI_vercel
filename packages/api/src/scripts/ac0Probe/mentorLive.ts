/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Probe-only sending boundary. Frozen Runtime/adapter own product semantics.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createBudget, usdToNano, type LedgerStore} from './budget.ts';
import {callBoundUsd} from './config.ts';
import {streamObserver} from './sse.ts';

export const MENTOR_LIMITS = {
  G: {model:'google/gemini-3.8-flash',route:'google-vertex/global',calls:40,usd:1.64,
    single:.10,prompt:.75,completion:3.75,tokens:8192,effort:'low',bytes:90000},
  S: {model:'anthropic/claude-sonnet-5.5',route:'anthropic',calls:40,usd:4.36,
    single:.27,prompt:2,completion:10,tokens:8192,effort:'low',bytes:90000},
} as const;
type LocalReason='client_disconnected'|'upstream_stream_error'|'timeout'|'size_limit'|'utf8'|'identity'|'local';
class MentorStop extends Error {}
export type MentorModel = keyof typeof MENTOR_LIMITS;
export type MentorSlot = {model:MentorModel;phase:'main-single-turn'|'e2e';id:string;requestHash:string};
export const sha256 = (raw:string) => createHash('sha256').update(raw).digest('hex');
export function mentorMaxUsd(value:string | undefined):number {
  if (!value || !/^\d+(\.\d{1,9})?$/.test(value)) throw new Error('MENTOR_MAX_USD_REQUIRED');
  const usd=Number(value);
  if (usd<=0 || usd>6) throw new Error('MENTOR_MAX_USD_CAP');
  return usd;
}

/** One process holds the existing ledger lock for the entire batch. Restarting
 * after even one reservation fails the exact post-interruption baseline; no resume/retry switch. */
export function mentorSender(options:{ledger:LedgerStore;maxUsd:number;slots:MentorSlot[];
  upstream:typeof fetch;authorization:string;save:(record:Record<string,unknown>)=>void}) {
  mentorMaxUsd(String(options.maxUsd));
  const baseline=options.ledger.read();
  if (baseline.calls!==834 || baseline.nanoUsd!==7863735263) throw new Error('MENTOR_BASELINE_CHANGED');
  const budget=createBudget({maxCalls:80,maxUsd:options.maxUsd,ledger:options.ledger});
  const modelTotals={G:{calls:0,nano:0},S:{calls:0,nano:0}};
  const used=new Set<string>();
  let busy=false, stopped=false;
  let expected={...baseline};
  const fail=(reason:string):never=>{stopped=true;budget.stop(reason);throw new MentorStop('MENTOR_STOP:'+reason);};
  return {
    stop(){stopped=true;budget.stop('stopped');},
    get totals(){return {run:budget.run,models:structuredClone(modelTotals)};},
    async send(raw:string,slot:Omit<MentorSlot,'requestHash'>,
      relay?:{headers:(response:Response)=>void;chunk:(bytes:Uint8Array)=>void;closed?:()=>boolean}):Promise<Response> {
      if(stopped) return fail('stopped');
      if(busy) return fail('previous_unsettled');
      busy=true;
      let reserved=false,disconnected=false;
      let localReason:LocalReason='local';
      let timeout:AbortSignal|undefined;
      const relayToClient=(action:()=>void)=>{
        if(disconnected)return;
        try{action();}catch{disconnected=true;}
      };
      let started=performance.now();
      const record:Record<string,unknown>={...slot,status:'not_sent',receivedBytes:0};
      try {
        if(!isDeepStrictEqual(options.ledger.read(),expected)) return fail('ledger_changed');
        const limits=MENTOR_LIMITS[slot.model];
        if(!limits||slot.phase!=='main-single-turn')return fail('main_only');
        const match=options.slots.find(s=>s.model===slot.model&&s.phase===slot.phase&&s.id===slot.id);
        const identity=slot.model+':'+slot.phase+':'+slot.id;
        if(!match||used.has(identity)) return fail('unapproved_or_duplicate_sample');
        const body=JSON.parse(raw),B=Buffer.byteLength(raw),requestHash=sha256(raw);
        if(slot.phase==='main-single-turn'&&match.requestHash!==requestHash) return fail('main_bytes_changed');
        const routing={allow_fallbacks:false,require_parameters:true,only:[limits.route],
          max_price:{prompt:limits.prompt,completion:limits.completion,request:0}};
        if(B>limits.bytes||body.model!==limits.model||body.max_tokens!==limits.tokens||
          body.reasoning_effort!==limits.effort||body.store!==false||
          !isDeepStrictEqual(body.provider,routing)||raw.includes('cache_control')||
          (body.stream!==true&&body.stream!==false)) return fail('request_profile');
        const bound=usdToNano(callBoundUsd({id:slot.model,model:limits.model,route:limits.route,
          maxPrice:{prompt:limits.prompt,completion:limits.completion}},B,limits.tokens));
        const own=modelTotals[slot.model];
        if(bound>usdToNano(limits.single)) return fail('single_cap');
        if(own.calls+1>limits.calls||own.nano+bound>usdToNano(limits.usd)) return fail('model_cap');
        Object.assign(record,{B,K:4096,M:4096,T:B+8192,requestHash,reserveNano:bound,
          route:limits.route,maxTokens:limits.tokens,effort:limits.effort});
        const settle=budget.reserve(bound); // Durable existing ledger write BEFORE upstream.
        reserved=true;used.add(identity);own.calls++;own.nano+=bound;
        expected=options.ledger.read();record.status='reserved';options.save(record);
        started=performance.now();
        const observer=streamObserver(()=>performance.now()-started);
        timeout=AbortSignal.timeout(240000);localReason='upstream_stream_error';
        const response=await options.upstream('https://openrouter.ai/api/v1/chat/completions',{
          method:'POST',body:raw,redirect:'error',signal:timeout,
          headers:{Authorization:options.authorization,'Content-Type':'application/json'},
        });
        record.httpStatus=response.status;
        const headerId=response.headers.get('x-generation-id');
        if(headerId&&/^[a-zA-Z0-9._:-]{1,256}$/.test(headerId))record.providerId=headerId;
        if(!response.ok||!response.body) {
          record.providerErrorCode=await rejectionCode(response);
          return fail('provider_rejected');
        }
        relayToClient(()=>relay?.headers(response));
        const chunks:Uint8Array[]=[];let size=0,pending='';
        const idDecoder=new TextDecoder();
        const reader=response.body.getReader();
        try {
          for(;;){const part=await reader.read();if(part.done)break;
            size+=part.value.length;record.receivedBytes=size;
            if(size>4*1024*1024){localReason='size_limit';return fail('response_size');}
            chunks.push(part.value);
            if(body.stream){
              observer.push(part.value);pending+=idDecoder.decode(part.value,{stream:true});
              let newline;
              while((newline=pending.indexOf('\n'))>=0){
                const line=pending.slice(0,newline);pending=pending.slice(newline+1);
                if(!line.startsWith('data:'))continue;
                let frame;try{frame=JSON.parse(line.slice(5));}catch{continue;}
                if(typeof frame?.id==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(frame.id)){
                  if(record.providerId&&record.providerId!==frame.id){localReason='identity';return fail('response_identity');}
                  record.providerId=frame.id;
                }
              }
            }
            relayToClient(()=>relay?.chunk(part.value));
          }
        } finally {await reader.cancel().catch(()=>{});}
        localReason='utf8';
        const bytes=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        localReason='identity';
        let usage,finish,providerId=record.providerId as string|undefined,refused=false;
        if(body.stream){
          const facts=observer.end();
          Object.assign(record,{firstValidContentMs:facts.firstContentMs??null,firstByteMs:facts.firstByteMs??null,
            firstToolMs:facts.firstToolMs??null,streamFacts:facts});
          if(!facts.done||facts.streamError||facts.malformedFrames){localReason='upstream_stream_error';return fail('incomplete_stream');}
          // Bind every SSE chunk identity, including the usage-only final chunk.
          for(const line of text.split('\n').filter(l=>l.startsWith('data:')&&!l.includes('[DONE]'))){
            const frame=JSON.parse(line.slice(5));
            if(frame.choices?.some((choice:{delta?:{refusal?:unknown}})=>choice.delta?.refusal))refused=true;
            if(frame.model!==undefined&&frame.model!==limits.model)return fail('response_model');
            if(frame.id){if(providerId&&providerId!==frame.id)return fail('response_identity');providerId=frame.id;}
          }
          usage=facts.usage;finish=facts.finishReason;
        } else {
          const parsed=JSON.parse(text);
          if(parsed.error||parsed.model!==limits.model||parsed.choices?.length!==1)return fail('response_identity');
          if(providerId&&providerId!==parsed.id)return fail('response_identity');
          providerId=parsed.id;finish=parsed.choices[0].finish_reason;
          refused=Boolean(parsed.choices[0].message?.refusal);
          usage={costUsd:parsed.usage?.cost,promptTokens:parsed.usage?.prompt_tokens,
            completionTokens:parsed.usage?.completion_tokens,reasoningTokens:parsed.usage?.completion_tokens_details?.reasoning_tokens};
        }
        localReason='local';
        const cost=usage?.costUsd;
        Object.assign(record,{providerId:providerId??null,prompt_tokens:usage?.promptTokens??null,
          reasoning_tokens:usage?.reasoningTokens??null,completion_tokens:usage?.completionTokens??null,
          providerCostUsd:cost??null,finishReason:finish??null,truncated:finish==='length',
          fullModelReplyMs:performance.now()-started,responseSha256:sha256(text),response:text});
        if(typeof providerId!=='string'||!providerId||!['stop','length','tool_calls','content_filter'].includes(finish)||
          typeof cost!=='number'||!Number.isFinite(cost)||cost<0||!Number.isSafeInteger(usdToNano(cost)))
          return fail('unknown_result');
        if(!isDeepStrictEqual(options.ledger.read(),expected))return fail('ledger_changed_during_send');
        const actual=usdToNano(cost);
        // A known overrun is recorded honestly, then prevents any further send.
        settle(actual);own.nano+=actual-bound;expected=options.ledger.read();
        record.status='settled';options.save(record);
        if(refused||finish==='content_filter')return fail('provider_refused');
        if(actual>bound||own.nano>usdToNano(limits.usd))return fail('actual_over_bound');
        disconnected ||= relay?.closed?.()??false;
        if(disconnected){localReason='client_disconnected';return fail('client_disconnected');}
        if(stopped)return fail('stopped');
        return new Response(bytes,{status:response.status,headers:response.headers});
      } catch(error) {
        stopped=true;budget.stop('unknown_or_rejected');
        if(reserved&&record.status!=='settled')record.status='unknown_or_rejected_reserved';
        record.localReason=timeout?.aborted?'timeout':localReason;
        record.elapsedMs=performance.now()-started;
        record.clientDisconnected=disconnected;
        record.stopReason=error instanceof MentorStop?error.message:'MENTOR_STOP:'+record.localReason;
        if(record.status!=='settled'){delete record.response;delete record.streamFacts;}
        options.save(record);
        throw new Error(String(record.stopReason)); // Never echo upstream/key-bearing errors.
      } finally {busy=false;}
    },
  };
}

// Never persist upstream messages, metadata, headers or arbitrary string codes.
async function rejectionCode(response:Response):Promise<number|null> {
  const reader=response.body?.getReader();
  if(!reader)return null;
  const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;){const part=await reader.read();if(part.done)break;
      size+=part.value.length;if(size>4096)return null;chunks.push(part.value);
    }
    const code=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code;
    return Number.isInteger(code)&&code>=100&&code<=599?code:null;
  }catch{return null;}finally{await reader.cancel().catch(()=>{});}
}
