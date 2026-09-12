/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {runSkillSlice,type CallEvidence} from './runner';
const completion=(finish='stop',message:unknown={role:'assistant',content:'Synthetic final'},usage:unknown={prompt_tokens:10,completion_tokens:4,total_tokens:14}) => new Response(JSON.stringify({id:'synthetic-response',object:'chat.completion',created:1,model:'qwen/test',choices:[{index:0,finish_reason:finish,message}],usage}),{headers:{'content-type':'application/json'}});
function setup() {
 const calls:CallEvidence[]=[];return {calls,input:{model:'qwen/test',apiKey:'synthetic-only',instructions:'SYNTHETIC_PRIVATE_ALPHA',input:'Use the selected artifact.',maxOutputTokens:100,
 beforeCall:vi.fn(async()=>undefined),recordCall:vi.fn(async(e:CallEvidence)=>{calls.push({...e});}),readArtifact:vi.fn(async()=> 'Fixed synthetic script A v1')}};
}
describe('real SDK bounded model/tool boundary with synthetic transport',()=>{
 it('runs a tool loop, meters both calls and keeps the fixed model and source',async()=>{
  const t=setup(),requests:any[]=[];
  const transport=vi.fn(async(url:any,init:any)=>{expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');const r=JSON.parse(init.body);requests.push(r);return requests.length===1?completion('tool_calls',{role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'read_selected_artifact',arguments:'{}'}}]}):completion();});
  const out=await runSkillSlice(t.input,transport);
  expect(out.body).toBe('Synthetic final');expect(out.calls).toHaveLength(2);expect(out.toolCalls).toBe(1);expect(t.input.readArtifact).toHaveBeenCalledTimes(1);
  expect(requests.every(r=>r.model==='qwen/test'&&r.provider.allow_fallbacks===false)).toBe(true);
  expect(JSON.stringify(requests[1].messages)).toContain('Fixed synthetic script A v1');
  expect(out.calls.every(c=>c.inputTokens===10&&c.outputTokens===4&&c.state==='responded')).toBe(true);
 });
 it('runs summary without tools or an extra model call',async()=>{
  const t=setup();const transport=vi.fn(async(_url:any,init:any)=>{expect(JSON.parse(init.body).tools??[]).toEqual([]);return completion();});
  const out=await runSkillSlice({...t.input,readArtifact:undefined},transport);
  expect(out.body).toBe('Synthetic final');expect(out.toolCalls).toBe(0);expect(transport).toHaveBeenCalledTimes(1);expect(t.input.readArtifact).not.toHaveBeenCalled();
 });
 it('never retries an uncertain provider failure',async()=>{
  const t=setup(),transport=vi.fn(async()=>{throw new Error('private SDK detail');});
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('OUTCOME_UNKNOWN');expect(transport).toHaveBeenCalledTimes(1);expect(t.calls[0].state).toBe('unknown');
 });
 it('rejects missing usage before SDK zero defaults',async()=>{
  const t=setup(),transport=vi.fn(async()=>completion('stop',undefined,null));
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('OUTCOME_UNKNOWN');expect(t.calls[0].inputTokens).toBeNull();expect(transport).toHaveBeenCalledTimes(1);
 });
 it('retains truncation and known usage without calling it success',async()=>{
  const t=setup(),transport=vi.fn(async()=>completion('length'));
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('TRUNCATED');expect(t.calls[0]).toMatchObject({finishReason:'length',state:'truncated',inputTokens:10});expect(transport).toHaveBeenCalledTimes(1);
 });
 it('does not reuse a previous Skills instructions in a fresh run',async()=>{
  const a=setup(),b=setup();b.input.instructions='SYNTHETIC_PRIVATE_BETA';const requests:string[]=[];
  const transport=vi.fn(async(_url:any,init:any)=>{requests.push(init.body);return completion();});
  await runSkillSlice(a.input,transport);await runSkillSlice(b.input,transport);
  expect(requests[0]).toContain('SYNTHETIC_PRIVATE_ALPHA');expect(requests[1]).toContain('SYNTHETIC_PRIVATE_BETA');expect(requests[1]).not.toContain('SYNTHETIC_PRIVATE_ALPHA');
 });
 it('does not call a model if admission or source reauthorization fails',async()=>{
  const t=setup();t.input.beforeCall.mockRejectedValue(new Error('denied'));const transport=vi.fn(async()=>completion());
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('OUTCOME_UNKNOWN');expect(transport).not.toHaveBeenCalled();
 });
 it('keeps known usage on a failed durable write and does not retry the write or model',async()=>{
  const t=setup();t.input.recordCall.mockRejectedValue(new Error('lost write acknowledgement'));
  const transport=vi.fn(async()=>completion());
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('OUTCOME_UNKNOWN');
  expect(transport).toHaveBeenCalledTimes(1);expect(t.input.recordCall).toHaveBeenCalledTimes(1);
  expect(t.input.recordCall.mock.calls[0][0]).toMatchObject({state:'responded',usageEvidence:{promptTokens:10,completionTokens:4}});
 });
 it('does not make a second call after the fixed source is revoked at tool read',async()=>{
  const t=setup();t.input.readArtifact.mockRejectedValue(new Error('source denied'));
  const transport=vi.fn(async()=>completion('tool_calls',{role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'read_selected_artifact',arguments:'{}'}}]}));
  await expect(runSkillSlice(t.input,transport)).rejects.toThrow('OUTCOME_UNKNOWN');
  expect(transport).toHaveBeenCalledTimes(1);expect(t.calls[0]).toMatchObject({state:'responded',inputTokens:10});
 });
 it('never exposes a private SDK error and disables trace network egress',async()=>{
  const t=setup();const outside=vi.fn(async()=>{throw new Error('unexpected egress');});
  vi.stubGlobal('fetch',outside);
  try {
   await runSkillSlice(t.input,vi.fn(async()=>completion()));
   expect(outside).not.toHaveBeenCalled();
  } finally {vi.unstubAllGlobals();}
 });
 it('does not accept a model switch or an already aborted dispatch',async()=>{
  const t=setup(),transport=vi.fn(async()=>completion());
  await expect(runSkillSlice({...t.input,model:'openai/gpt-test'},transport)).rejects.toThrow('MODEL_NOT_ALLOWED');
  await expect(runSkillSlice({...t.input,signal:AbortSignal.abort()},transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
 });
});
