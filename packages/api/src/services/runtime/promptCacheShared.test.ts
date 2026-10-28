/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {applyPromptCache,freezeSharedCacheInto,freezeSharedPromptCache,promptCacheReserveBytes,
 PROMPT_CACHE_OVERHEAD_BYTES,PROMPT_CACHE_V3_RESERVE_BYTES} from './promptCache';
import {withPrimaryAddenda} from './primaryInstructions';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const model='anthropic/test',write='2.5';
// Admission-time free-chat system text (brand + base rules + Skill catalog); the executor appends per-user addenda.
const frozen='Identity rules\nAnswer the user request directly.\nSkills: [{"name":"写作"}]';
const addenda=withPrimaryAddenda('',{replyLanguage:'reply-language-v1',workspaceContext:true});
const system=frozen+addenda;
const policy=freezeSharedPromptCache({real:true,model,cacheWriteUsdPerMillion:write,instructions:frozen,prefixChars:frozen.length,historyMarker:true})!;
const marked=(text:string)=>({type:'text',text,cache_control:{type:'ephemeral'}});
/** The bytes Anthropic hashes before each marker: everything up to and including the marked block's text. */
function cachedPrefixes(request:{messages:Array<{role:string;content:unknown}>;tools?:unknown}):string[]{
 const prefixes:string[]=[];let seen=JSON.stringify(request.tools??[]);
 for(const message of request.messages){
  const parts=Array.isArray(message.content)?message.content as Array<{text:string;cache_control?:unknown}>:[{text:String(message.content)}];
  for(const part of parts){seen+=message.role+':'+part.text;if(part.cache_control)prefixes.push(sha(seen));}
 }
 return prefixes;
}

it('freezes the admission-time prefix and refuses ineligible turns',()=>{
 expect(policy).toEqual({version:'prompt-cache-v3',systemPrefixChars:frozen.length,systemPrefixSha256:sha(frozen),historyMarker:true});
 for(const patch of [{real:false},{model:'google/test'},{model:'openai/test'},{cacheWriteUsdPerMillion:undefined},{prefixChars:0}])
  expect(freezeSharedPromptCache({real:true,model,cacheWriteUsdPerMillion:write,instructions:frozen,prefixChars:frozen.length,historyMarker:true,...patch})).toBeUndefined();
 expect(()=>freezeSharedPromptCache({real:true,model,cacheWriteUsdPerMillion:write,instructions:frozen,prefixChars:frozen.length+1,historyMarker:true}))
  .toThrow('RUNTIME_CONTEXT_INVALID');
});
it('marks the shared prefix, the per-user tail and the last plain history message; text is unchanged',()=>{
 const history=[{role:'user',content:'第一问'},{role:'assistant',content:'第一答'}];
 const request={messages:[{role:'system',content:system},...history,{role:'user',content:'第二问'}]};
 applyPromptCache(request,policy,model,write);
 expect(request.messages).toEqual([
  {role:'system',content:[marked(frozen),marked(addenda)]},
  {role:'user',content:'第一问'},{role:'assistant',content:[marked('第一答')]},{role:'user',content:'第二问'},
 ]);
 const text=(request.messages[0]!.content as unknown as Array<{text:string}>).map(part=>part.text).join('');
 expect(text).toBe(system);
});
it('uses one marked block when the executor appended nothing, and no history marker on a first turn',()=>{
 const request={messages:[{role:'system',content:frozen},{role:'user',content:'第一问'}]};
 applyPromptCache(request,policy,model,write);
 expect(request.messages).toEqual([{role:'system',content:[marked(frozen)]},{role:'user',content:'第一问'}]);
});
it('keeps the cached prefix bytes identical across consecutive turns of one conversation, through a tool round',()=>{
 const tools=[{type:'function',function:{name:'web_search',parameters:{}}}];
 const turn=(messages:Array<{role:string;content:unknown;tool_calls?:unknown;tool_call_id?:string}>)=>{
  const request={tools,messages:[{role:'system',content:system},...messages]};
  applyPromptCache(request,policy,model,write);return request;
 };
 const call={role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'web_search',arguments:'{}'}}]};
 const result={role:'tool',content:'found',tool_call_id:'c1'};
 const first=turn([{role:'user',content:'第一问'}]);
 const firstToolRound=turn([{role:'user',content:'第一问'},call,result]);
 const second=turn([{role:'user',content:'第一问'},call,result,{role:'assistant',content:'第一答'},{role:'user',content:'第二问'}]);
 const third=turn([{role:'user',content:'第一问'},call,result,{role:'assistant',content:'第一答'},{role:'user',content:'第二问'},
  {role:'assistant',content:'第二答'},{role:'user',content:'第三问'}]);
 const [p1,p2,p3,p4]=[first,firstToolRound,second,third].map(cachedPrefixes);
 // The two system breakpoints hash identically on every call; the history breakpoint of turn N+1 extends turn N's prefix.
 expect(p1).toHaveLength(2);expect(p2).toEqual(p1);expect(p3!.slice(0,2)).toEqual(p1);expect(p4!.slice(0,2)).toEqual(p1);
 expect(p3).toHaveLength(3);expect(p4).toHaveLength(3);expect(p4![2]).not.toBe(p3![2]);
 expect((second.messages[4] as {content:unknown}).content).toEqual([marked('第一答')]);
 expect((third.messages[6] as {content:unknown}).content).toEqual([marked('第二答')]);
 // The marker never lands on a tool pair or on the current user message.
 expect(firstToolRound.messages.slice(1).every(m=>typeof m.content==='string'||m.content===null)).toBe(true);
});
it('rejects a prefix that no longer matches the executor system text before any claim',()=>{
 for(const content of [system.slice(1),'X'+system.slice(1),frozen.slice(0,-1)])
  expect(()=>applyPromptCache({messages:[{role:'system',content},{role:'user',content:'q'}]},policy,model,write)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
 expect(()=>applyPromptCache({messages:[{role:'system',content:system},{role:'user',content:'q'}]},policy,'google/test',write)).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
});
it('freezes into the context only for an eligible turn and rehashes the billing source',()=>{
 const context={model,instructions:frozen},billing={sourceHash:'stale'};
 freezeSharedCacheInto(context,billing,undefined);
 expect(context).not.toHaveProperty('promptCache');expect(billing.sourceHash).toBe('stale');
 freezeSharedCacheInto(context,billing,write);
 expect(context).toMatchObject({promptCache:policy});
 expect(billing.sourceHash).toBe(sha(JSON.stringify(context)));
 const kept={model,instructions:frozen,promptCache:{version:'prompt-cache-v1' as const,systemPrefixChars:1,systemPrefixSha256:sha('I')}};
 freezeSharedCacheInto(kept,billing,write);
 expect(kept.promptCache.version).toBe('prompt-cache-v1');
});
it('reserves the v3 marker bytes as soon as the turn is eligible, before its policy exists',()=>{
 const two=[marked('a'),marked('b')];
 expect(PROMPT_CACHE_V3_RESERVE_BYTES).toBe(Buffer.byteLength(JSON.stringify(two))-Buffer.byteLength(JSON.stringify('ab'))+
  Buffer.byteLength(JSON.stringify([marked('a')]))-Buffer.byteLength(JSON.stringify('a')));
 expect(promptCacheReserveBytes(undefined,write)).toBe(PROMPT_CACHE_V3_RESERVE_BYTES);
 expect(promptCacheReserveBytes(policy)).toBe(PROMPT_CACHE_V3_RESERVE_BYTES);
 expect(promptCacheReserveBytes(undefined)).toBe(0);
 expect(promptCacheReserveBytes({version:'prompt-cache-v1',systemPrefixChars:1,systemPrefixSha256:sha('I')})).toBe(PROMPT_CACHE_OVERHEAD_BYTES);
});
