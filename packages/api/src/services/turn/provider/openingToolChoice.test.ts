/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
const limits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',requestUsd:'0'};
const identity={provider:'openrouter',account:'synthetic',model:'anthropic/test',protocol:'openrouter-chat-v1' as const,
 providerLimits:limits,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd};
const tools=[{type:'function',function:{name:'ask_question',parameters:{}}}];
const make=(patch:Record<string,unknown>)=>({model:identity.model,stream:false,store:false,max_tokens:100,
 provider:openRouterBound(limits,100).routing,messages:[{role:'system',content:'rules'},{role:'user',content:'opening'}],tools,...patch});
it('PROMPT-CACHE-ALL: accepts tool_choice none on an Agent turn that offers its tools, forwarding exact bytes',async()=>{
 const credential=vi.fn(async()=> 'SYNTHETIC'),transport=vi.fn<typeof fetch>(async()=>new Response('{}'));
 const input=JSON.stringify(make({tool_choice:'none'}));
 await openRouterAdapter({credential,transport,allowAgentTools:true}).dispatch({input},identity);
 expect(transport.mock.calls[0]?.[1]?.body).toBe(input);
});
it.each([
 ['any other value',{tool_choice:'auto'},{allowAgentTools:true}],
 ['a required tool',{tool_choice:{type:'function',function:{name:'ask_question'}}},{allowAgentTools:true}],
 ['no tools offered',{tool_choice:'none',tools:[]},{allowAgentTools:true}],
 ['a free-chat (workspace) request',{tool_choice:'none',tools:[{type:'function',function:{name:'read_source',parameters:{}}}]},{allowWorkspaceRead:true}],
 ['an adapter without Agent tools',{tool_choice:'none'},{allowWorkspaceRead:true}],
])('rejects tool_choice with %s before credentials and transport',async(_name,patch,options)=>{
 const credential=vi.fn(),transport=vi.fn();
 await expect(openRouterAdapter({credential,transport,...options}).dispatch({input:JSON.stringify(make(patch))},identity))
  .rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
