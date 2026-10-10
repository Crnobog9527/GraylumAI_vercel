/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it, vi} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256} from '../skills/loader';
import {executionSkillFileTool, type ToolRpc} from './skillFileExecution';
import {freezeSkillFileBinding} from './skillFile';
const packageId='10000000-0000-4000-8000-000000000001';
const revisionId='10000000-0000-4000-8000-000000000002';
const content='Synthetic private reference';
const base={packageId,revisionId,directoryName:'test',tasks:{},requiredCapabilities:[],files:[
  {path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[]},
  {path:'ref.md',bytes:Buffer.byteLength(content),sha256:sha256(content),mediaType:'text/markdown' as const,requires:[]},
]};
const descriptor={...base,packageHash:packageHash(base)};
beforeEach(clearSkillResourceCache);
it('claims before reading, freezes once and replays the exact persisted JSON byte order',async()=>{
  let saved:unknown=null;
  const calls:string[]=[];
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    calls.push(`${name}:${args.p_action??args.p_path}`);
    if(name==='runtime_tool'&&args.p_action==='claim')return {result:saved};
    if(name==='runtime_tool'&&args.p_action==='complete'){
      saved=Object.fromEntries(Object.entries(args.p_result as object).reverse());
      return {result:saved};
    }
    if(args.p_path===null)return descriptor;
    if(args.p_path==='')return true;
    return Buffer.from(content).toString('base64');
  });
  const tool=executionSkillFileTool({executionId:packageId,moduleId:packageId,
    binding:freezeSkillFileBinding(descriptor),rpc:rpc as ToolRpc,assertCanStart:()=>{}});
  const first=await tool.execute({path:'ref.md'},'call_1');
  const second=await tool.execute({path:'ref.md'},'call_1');
  expect(second).toBe(first);
  expect(calls[0]).toBe('runtime_tool:claim');
  expect(calls.filter(call=>call==='runtime_tool:complete')).toHaveLength(1);
  expect(calls.filter(call=>call==='read_skill_package:ref.md')).toHaveLength(1);
});
it('does not read private data if execution ownership/cancellation/erasure claim is denied',async()=>{
  const rpc=vi.fn(async()=>{throw new Error('RUNTIME_TOOL_DENIED');});
  const tool=executionSkillFileTool({executionId:packageId,moduleId:packageId,
    binding:freezeSkillFileBinding(descriptor),rpc,assertCanStart:()=>{}});
  await expect(tool.execute({path:'ref.md'},'call_1')).rejects.toThrow('RUNTIME_TOOL_DENIED');
  expect(rpc).toHaveBeenCalledTimes(1);
});
