/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';
import {groundedCardTool,cardSources,rejectSeparateCardProse} from './groundedCard';
import {agentTurnResult} from './agentTurnResult';
import {NativeSession} from './nativeSession';
import {NativeProgressProjection} from './nativeProgress';
it.each(['','单独生成的另一套安排。'])('SDK, public projection and saved history agree with guarded cards (%j)',async prose=>{
 const stored:unknown[]=[];
 const session:Session={getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async items=>{stored.push(...items);},
  popItem:async()=>undefined,clearSession:async()=>{}};
 const native=new NativeSession(session,true),projection=new NativeProgressProjection({mode:'agent',toolMessage:false,appendCard:true});
 let sources=cardSources('比较甲和乙',[]),sent=0;
 const args={intent:'grounded_comparison',requestQuote:'甲和乙',basisQuotes:['比较甲和乙'],question:'如何选？',
  options:[{text:'甲',reason:'便于小步验证'},{text:'乙',reason:'便于集中准备'}],recommended:0};
 const output=await runRuntime({model:'synthetic',instructions:'Synthetic',input:sources.current,session:native,
  tools:[groundedCardTool(()=>sources)],maxOutputTokens:1000,maxTurns:1,stream:true,firstToolCallOnly:true,
  allowEmptyResult:true,commitSessionOnSuccess:true,stopAtToolNames:['ask_question'],
  selectHistory:async(h,i)=>{sources=cardSources(sources.current,[...h,...i]);return [...h,...i];},
  onText:text=>{projection.appendText(text);},exchange:async(_sequence,_request,onChunk)=>{
   sent++;
   const call={index:0,id:'synthetic-call',type:'function',function:{name:'ask_question',arguments:JSON.stringify(args)}};
   const frame={id:'synthetic',object:'chat.completion.chunk',created:1,model:'synthetic',
    choices:[{index:0,delta:{role:'assistant',content:prose||null,tool_calls:[call]},finish_reason:'tool_calls'}]};
   expect(projection.appendToolFrame(frame)).toBeNull();onChunk?.(JSON.stringify(frame));
   return JSON.stringify({...frame,object:'chat.completion',choices:[{index:0,finish_reason:'tool_calls',
    message:{role:'assistant',content:prose||null,tool_calls:[call]}}]});
  }});
 const result=rejectSeparateCardProse(prose,agentTurnResult(prose,output,true,undefined,true,false));
 projection.finish(result.message);
 expect(projection.text).toBe(result.message);expect(sent).toBe(1);
 expect(result.card===null).toBe(Boolean(prose));
 await native.finish(result.body,true,false);
 const last=stored.at(-1) as {content:Array<{text:string}>};
 expect(last.content[0]!.text).toBe(result.message);
 expect(JSON.stringify(stored)).not.toContain('basisQuotes');
});
