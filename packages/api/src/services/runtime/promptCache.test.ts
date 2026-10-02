/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {frozenCallPolicy} from '../bill2/service';
import {createHash} from 'node:crypto';
import golden from './promptCacheGolden.json';
import {openRouterRequestBody,type RequestContext} from './providerRequest';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {applyPromptCache,freezePromptCache,PROMPT_CACHE_OVERHEAD_BYTES} from './promptCache';
const instructions='技能内容\n固定规则\n\n变化内容';
const input={real:true,role:'skill',model:'anthropic/test',cacheWriteUsdPerMillion:'2.5',
 instructions,skillChars:4,stableAdditionalChars:6};
const cache=freezePromptCache(input)!;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
it.each(golden)('preserves pre-implementation bytes and hash: $context.providerRequestFormat / $phase',fixture=>{
 const output=openRouterRequestBody(fixture.request,{context:fixture.context as RequestContext,policy:frozenCallPolicy.parse(fixture.policy),
  phase:fixture.phase,primaryDialogue:fixture.phase==='skill'});
 expect(output).toBe(fixture.output);
 expect(sha(output)).toBe(fixture.requestHash);
});
it('freezes exactly the Skill and trusted stable host prefix',()=>{
 expect(cache).toEqual({version:'prompt-cache-v1',systemPrefixChars:11,systemPrefixSha256:sha(instructions.slice(0,11))});
 expect(freezePromptCache({...input,stableAdditionalChars:undefined})?.systemPrefixChars).toBe(4);
});
it.each([{real:false},{role:'ordinary'},{role:'auto'},{role:'organizer'},{role:'matching'},
 {model:'google/gemini'},{model:'openai/gpt-6-luna'},{cacheWriteUsdPerMillion:undefined},{skillChars:0}])('does not opt in: %j',patch=>{
 expect(freezePromptCache({...input,...patch})).toBeUndefined();
});
it('splits only the first system content, preserves all text, and replays identically',()=>{
 const make=()=>({messages:[{role:'system',content:instructions},{role:'user',content:'hello'}]});
 const request=make(),replay=make();
 applyPromptCache(request,cache,input.model,input.cacheWriteUsdPerMillion);
 applyPromptCache(replay,cache,input.model,input.cacheWriteUsdPerMillion);
 expect(request).toEqual(replay);
 expect(request.messages[0].content).toEqual([
  {type:'text',text:instructions.slice(0,11),cache_control:{type:'ephemeral'}},
  {type:'text',text:instructions.slice(11)},
 ]);
 expect(Buffer.byteLength(JSON.stringify(request))-Buffer.byteLength(JSON.stringify(make()))).toBe(PROMPT_CACHE_OVERHEAD_BYTES);
});
it('uses one block for an entire-system prefix',()=>{
 const request={messages:[{role:'system',content:instructions}]};
 applyPromptCache(request,freezePromptCache({...input,skillChars:instructions.length,stableAdditionalChars:0})!,input.model,'2.5');
 expect(request.messages[0].content).toEqual([{type:'text',text:instructions,cache_control:{type:'ephemeral'}}]);
});
it.each([
 {systemPrefixChars:0},{systemPrefixChars:99999},{systemPrefixSha256:'0'.repeat(64)},
])('rejects invalid frozen prefix before claim: %j',patch=>{
 expect(()=>applyPromptCache({messages:[{role:'system',content:instructions}]},{...cache,...patch},input.model,'2.5'))
  .toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
});
it.each([[],[{role:'user',content:instructions},{role:'system',content:instructions}],
 [{role:'system',content:[{type:'text',text:instructions}]}],[{role:'system',content:instructions,name:'extra'}]].map(messages=>[messages]))('rejects a displaced or unexpected system shape',messages=>{
 expect(()=>applyPromptCache({messages},cache,input.model,'2.5')).toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
});
it('binds marking to primary dialogue and preserves organizer and matching bytes',()=>{
 const fixture=golden.find(row=>row.context.providerRequestFormat==='serial-tools-v2')!;
 const policy={...frozenCallPolicy.parse(fixture.policy),providerLimits:{...fixture.policy.providerLimits,cacheWriteUsdPerMillion:'2.5'}};
 policy.upperUsd=openRouterBound(policy.providerLimits,policy.outputLimit).upperUsd;
 const request=JSON.stringify({...JSON.parse(fixture.request),messages:[{role:'system',content:instructions}]});
 const context={...fixture.context,promptCache:cache} as RequestContext;
 const send=(phase:string,primaryDialogue:boolean,ctx=context)=>openRouterRequestBody(request,{context:ctx,policy,phase,primaryDialogue});
 const marked=send('skill',true);
 expect(JSON.parse(marked).messages[0].content[0].cache_control).toEqual({type:'ephemeral'});
 expect(sha(send('skill',true))).toBe(sha(marked));
 for(const phase of ['attached_organizer','matching'])
  expect(send(phase,false)).toBe(send(phase,false,{...context,promptCache:undefined}));
});
