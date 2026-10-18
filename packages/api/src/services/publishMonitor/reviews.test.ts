/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({prepare:vi.fn(),execute:vi.fn(),cancel:vi.fn(),policy:vi.fn(),settings:vi.fn()}));
vi.mock('../runtime/admission',()=>({runtimeAdmissionService:()=>({prepare:m.prepare})}));
vi.mock('../runtime/execute',()=>({runtimeExecutor:()=>({execute:m.execute,cancel:m.cancel})}));
vi.mock('../runtime/stagingPolicy',()=>({loadStagingPolicy:m.policy,loadStagingRecoveryPolicy:m.policy}));
vi.mock('../runtime/stagingTransport',()=>({stagingTransport:()=>({})}));
vi.mock('../runtime/newWorkGate',()=>({newWorkGate:()=>({calls:vi.fn()})}));
vi.mock('./reviewSettings',()=>({readReviewSettings:m.settings}));
import {advanceReview,prepareReview,runWeeklyReviews,type ReviewClaim} from './reviews';
const c:ReviewClaim={id:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',
 token:'33333333-3333-4333-8333-333333333333',requestId:'44444444-4444-4444-8444-444444444444',
 sessionId:'55555555-5555-4555-8555-555555555555',modelId:'66666666-6666-4666-8666-666666666666',maxCostUsd:'0.100000000000'};
beforeEach(()=>{vi.clearAllMocks();m.policy.mockResolvedValue({id:'test',creditsPerUsd:'100',multiplier:'6'});
 m.settings.mockResolvedValue({enabled:true});m.prepare.mockResolvedValue({executionId:'existing'});m.execute.mockResolvedValue({state:'completed'});});
const db=(read:Record<string,unknown>)=>({rpc:vi.fn(async()=>({data:read,error:null}))});
it('recovery finds the original execution and never re-admits or changes the request id',async()=>{
 const d=db({allowed:true,executionId:'original',state:'interrupted'});
 expect(await prepareReview(d as never,c,{})).toBe('original');expect(m.prepare).not.toHaveBeenCalled();
 expect(m.policy).not.toHaveBeenCalled();
});
it('a new admission uses the frozen request, session, model and review cap',async()=>{
 const d=db({allowed:true,executionId:null,state:null});
 expect(await prepareReview(d as never,c,{})).toBe('existing');
 expect(m.prepare).toHaveBeenCalledWith(expect.objectContaining({requestId:c.requestId,sessionId:c.sessionId,
  selection:{kind:'ordinary',modelId:c.modelId},network:'deny'}));
});
it('insufficient balance is skipped without a model dispatch; configuration failures are distinct',async()=>{
 const d=db({allowed:true,executionId:null,state:null});m.prepare.mockRejectedValue(new Error('BILL2_INSUFFICIENT_CREDITS'));
 expect(await prepareReview(d as never,c,{})).toBe(null);
 expect(d.rpc).toHaveBeenLastCalledWith('publish_monitor_review_step',expect.objectContaining({p_action:'skip',p_reason:'BALANCE_LOW'}));
 expect(m.execute).not.toHaveBeenCalled();
});
it('turning off cancels an existing native execution and prevents new paid work',async()=>{
 const d=db({allowed:false,executionId:'original',state:'prepared'});
 expect(await prepareReview(d as never,c,{})).toBe(null);expect(m.execute).not.toHaveBeenCalled();
 expect(d.rpc).toHaveBeenCalledWith('runtime_cancel',{p_actor_id:c.actorId,p_execution_id:'original'});
});
it('a balance pause during generation is cancelled and skipped, no automatic top-up retry',async()=>{
 m.execute.mockResolvedValue({state:'waiting_credits'});const d=db({allowed:true,executionId:'original',state:'running'});
 await advanceReview(d as never,c,'original',{});
 expect(m.cancel).toHaveBeenCalledExactlyOnceWith('original');
 expect(d.rpc).toHaveBeenLastCalledWith('publish_monitor_review_step',expect.objectContaining({p_reason:'BALANCE_LOW'}));
});
it('cron prepares work but defers model execution outside the cron response',async()=>{
 const d={rpc:vi.fn(async(name:string)=>({data:name==='publish_monitor_review_claim'?[c]:{allowed:true,executionId:'original',state:'prepared'},error:null}))};
 const defer=vi.fn();expect(await runWeeklyReviews(d as never,{env:{},defer},100,()=>0)).toMatchObject({claimed:1,scheduled:1});
 expect(defer).toHaveBeenCalledOnce();expect(m.execute).not.toHaveBeenCalled();
});

it('an expired native owner resumes its exact saved epoch/cursor once',async()=>{
 m.execute.mockResolvedValueOnce({state:'waiting_resume',cursor:2,epoch:1}).mockResolvedValueOnce({state:'completed'});
 const d=db({allowed:true,executionId:'original',state:'interrupted'});
 await advanceReview(d as never,c,'original',{});
 expect(m.execute).toHaveBeenCalledTimes(2);
 expect(m.execute).toHaveBeenLastCalledWith('original',undefined,{executionId:'original',cursor:2,epoch:1});
});

it.each([false,true])('before the review migration, a missing RPC is safe only with the feature off (%s)',async enabled=>{
 m.settings.mockResolvedValue({enabled});
 const d={rpc:vi.fn(async()=>({data:null,error:{code:'PGRST202'}}))};
 const pending=runWeeklyReviews(d as never,{env:{},defer:vi.fn()},100,()=>0);
 if(enabled)await expect(pending).rejects.toThrow('PUBLISH_MONITOR_REVIEW_CLAIM_FAILED');
 else expect(await pending).toMatchObject({claimed:0,scheduled:0,failed:0,enabled:false});
 expect(m.prepare).not.toHaveBeenCalled();expect(m.execute).not.toHaveBeenCalled();
});
