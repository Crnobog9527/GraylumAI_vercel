/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {retainedOutputReason} from './view';
it.each(['RUNTIME_CONTEXT_REVOKED','RUNTIME_SCOPE_DENIED','BILL2_ACTOR_DENIED'])('diagnosis cannot block financial recovery after %s',async message=>{
 const rpc=vi.fn().mockResolvedValue({data:null,error:{message}});
 expect(await retainedOutputReason({rpc},'actor','execution')).toBeUndefined();expect(rpc).toHaveBeenCalledTimes(1);
});
it('rechecks a scope revocation between execution read and projection',async()=>{
 const rpc=vi.fn().mockResolvedValueOnce({data:{sessionId:'session'},error:null}).mockResolvedValueOnce({data:null,error:{message:'RUNTIME_SCOPE_DENIED'}});
 expect(await retainedOutputReason({rpc},'actor','execution')).toBeUndefined();
});
it.each(['RUNTIME_EXECUTION_DENIED','storage unavailable'])('does not swallow identity or unknown storage errors: %s',async message=>{
 const rpc=vi.fn().mockResolvedValue({data:null,error:{message}});
 await expect(retainedOutputReason({rpc},'actor','execution')).rejects.toThrow('RUNTIME_OUTCOME_UNAVAILABLE');
});
it('old read projection remains compatible without a diagnosis',async()=>{
 const rpc=vi.fn().mockResolvedValueOnce({data:{sessionId:'session'},error:null}).mockResolvedValueOnce({data:{executions:[{executionId:'execution',unavailableReason:null}]},error:null});
 expect(await retainedOutputReason({rpc},'actor','execution')).toBeUndefined();
});
