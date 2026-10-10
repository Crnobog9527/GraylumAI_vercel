/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it, vi} from 'vitest';
import type {Session, AgentInputItem} from '@openai/agents';
import {runRuntime} from './runner';
import {skillFileTool} from './skillFile';
import {askQuestionTool} from './agentTools';
import {terminalAgentReplyFailure} from './terminalAgentReply';
const readCall = {id: 'read_1', type: 'function', function: {
  name: 'read_skill_file', arguments: '{"path":"references/guide.md"}',
}};
const response = (content: string | null, tool_calls?: unknown[]) => JSON.stringify({
  id: 'test', object: 'chat.completion', created: 1, model: 'fixture',
  choices: [{index: 0, finish_reason: tool_calls ? 'tool_calls' : 'stop',
    message: {role: 'assistant', content, ...(tool_calls ? {tool_calls} : {})}}],
});

it.each([false, true])('continues after a frozen file read and saves a complete SDK history (stream=%s)', async stream => {
  const writes: AgentInputItem[][] = [];
  const session: Session = {getSessionId: async () => 'test', getItems: async () => [],
    addItems: async items => {writes.push(items);}, popItem: async () => undefined, clearSession: async () => {}};
  const read = vi.fn(async () => '{"content":"fixed reference"}');
  const requests: string[] = [];
  const exchange = vi.fn(async (_sequence: number, body: string) => {
    requests.push(body);
    expect(writes).toHaveLength(0);
    return requests.length === 1 ? response(null, [readCall]) : response('Reference-grounded answer');
  });
  const output = await runRuntime({model: 'fixture', instructions: 'Read then answer.', input: 'help',
    session, maxOutputTokens: 100, maxTurns: 2, tools: [askQuestionTool(), skillFileTool(read)],
    stream, firstToolCallOnly: true, commitSessionOnSuccess: true, allowEmptyResult: true,
    stopAtToolNames: ['ask_question'], selectHistory: async (_history, incoming) => incoming, exchange});
  expect(output).toBe('Reference-grounded answer');
  expect(read).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledTimes(2);
  expect(requests[1]).toContain('fixed reference');
  expect(JSON.stringify(writes)).toContain('read_1');
  expect(JSON.stringify(writes)).toContain('fixed reference');
});
it('accepts file calls only when the frozen host context offered that tool', () => {
  const parsed = JSON.parse(response(null, [readCall]));
  expect(terminalAgentReplyFailure(parsed, false, true)).toBe(true);
  expect(terminalAgentReplyFailure(parsed, false, true, true)).toBe(false);
  expect(terminalAgentReplyFailure(parsed, true, true, true)).toBe(true);
});

it('reserves escaped file bytes before freezing a nearly full history block',async()=>{
 const {skillFileContinuationBytes}=await import('./skillFile');
 const {packageHash,sha256}=await import('../skills/loader');
 const {selectBlockHistory,validateBlockCall}=await import('./historySelection');
 const content='\u0001'.repeat(4000);
 const result=JSON.stringify({content,path:'ref.md',sha256:'a'.repeat(64),packageId:'b'.repeat(36),
  revisionId:'c'.repeat(36),packageHash:'d'.repeat(64)});
 const base={packageId:'10000000-0000-4000-8000-000000000001',revisionId:'10000000-0000-4000-8000-000000000002',
  directoryName:'fixture',requiredCapabilities:[],tasks:{},files:[{path:'SKILL.md',bytes:4000,
   sha256:sha256(content),mediaType:'text/markdown' as const,requires:[]}]};
 const descriptor={...base,packageHash:packageHash(base)};
 const reserve=await skillFileContinuationBytes({list:async()=>[descriptor],state:async()=> 'enabled',
  read:async()=>Buffer.from(content)},descriptor);
 const history=[{role:'user',content:'x'.repeat(28000)}];
 let count=0;
 const options={instructions:'Read',inputBytes:50000,historyItems:100,toolBytes:2000,
  historySelection:{version:'block-cut-v1',blockRevisions:16,currentReserveBytes:1000,markerReserveBytes:150},revisions:[1]} as const;
 const session:Session={getSessionId:async()=> 'test',getItems:async()=>history as AgentInputItem[],
  addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}};
 let calls=0;
 expect(await runRuntime({model:'fixture',instructions:'Read',input:'Help',session,maxOutputTokens:100,maxTurns:2,
  tools:[skillFileTool(async()=>result)],firstToolCallOnly:true,selectHistory:async(h,i)=>{
   const selected=selectBlockHistory(h,i,{...options,toolBytes:options.toolBytes+reserve});
   count=selected.length-i.length;return selected;
  },filterModelInput:items=>validateBlockCall(items,count,options) as AgentInputItem[],
  exchange:async(_sequence,body)=>{
   expect(Buffer.byteLength(body)).toBeLessThan(options.inputBytes);
   return ++calls===1?response(null,[readCall]):response('Done');
  }})).toBe('Done');
 expect(count).toBe(0);expect(calls).toBe(2);
});
