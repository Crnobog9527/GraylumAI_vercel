/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readSelectedArtifact} from './artifactReader';
function fixture(){
 const actor=randomUUID(),execution=randomUUID();
 const getUser=vi.fn(async()=>({error:null,data:{user:{id:actor,email_confirmed_at:'2026-01-01T00:00:00Z'}}}));
 const response={data:{kind:'formal_report',version:1,sections:[{title:'Script',body:'Fixed A1'}]},error:null as unknown};
 const rpc=vi.fn(()=>({abortSignal:()=>Promise.resolve(response)}));
 return {actor,execution,getUser,rpc,response,read:()=>readSelectedArtifact({auth:{getUser}} as never,{rpc} as never,execution)};
}
it('uses only the fixed execution identity and reauthorizes each production read',async()=>{
 const f=fixture();expect(JSON.parse(await f.read())).toEqual(f.response.data);
 expect(f.rpc).toHaveBeenCalledWith('agent_slice_selected_source',{p_actor_id:f.actor,p_execution_id:f.execution});
 f.response.error={code:'42501'};await expect(f.read()).rejects.toThrow('SLICE_SOURCE_UNAVAILABLE');
 expect(f.getUser).toHaveBeenCalledTimes(2);
});
it('refuses revoked identity before RPC and malformed source instead of returning content',async()=>{
 const f=fixture();f.getUser.mockResolvedValue({error:null,data:{user:{id:f.actor,email_confirmed_at:''}}});
 await expect(f.read()).rejects.toThrow('SLICE_DENIED');expect(f.rpc).not.toHaveBeenCalled();
 const g=fixture();g.response.data.sections=[];await expect(g.read()).rejects.toThrow();
});
