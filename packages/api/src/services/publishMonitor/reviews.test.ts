/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({prepare:vi.fn(),execute:vi.fn(),cancel:vi.fn(),policy:vi.fn(),settings:vi.fn(),executor:vi.fn()}));
vi.mock('../runtime/admission',()=>({runtimeAdmissionService:()=>({prepare:m.prepare})}));
vi.mock('../runtime/execute',()=>({runtimeExecutor:(options:unknown)=>{m.executor(options);return {execute:m.execute,cancel:m.cancel};}}));
vi.mock('../runtime/stagingPolicy',()=>({loadStagingPolicy:m.policy,loadStagingRecoveryPolicy:m.policy}));
vi.mock('../runtime/stagingTransport',()=>({stagingTransport:()=>({})}));
vi.mock('../runtime/newWorkGate',()=>({newWorkGate:()=>({calls:vi.fn()})}));
vi.mock('./reviewSettings',()=>({readReviewSettings:m.settings}));
import {createRuntimeBudget} from '../runtime/budget';
import {capReviewAdmission} from './reviewAdmission';
import {advanceReview,prepareReview,runWeeklyReviews,type ReviewClaim} from './reviews';
const c:ReviewClaim={id:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',
 token:'33333333-3333-4333-8333-333333333333',requestId:'44444444-4444-4444-8444-444444444444',
 sessionId:'55555555-5555-4555-8555-555555555555',modelId:'66666666-6666-4666-8666-666666666666',maxCostUsd:'0.100000000000'};
beforeEach(()=>{vi.clearAllMocks();m.policy.mockResolvedValue({id:'test',creditsPerUsd:'100',multiplier:'6'});
 m.settings.mockResolvedValue({enabled:true});m.prepare.mockResolvedValue({executionId:'existing'});m.execute.mockResolvedValue({state:'completed'});});
const db=(read:Record<string,unknown>)=>({rpc:vi.fn<(name:string,args:Record<string,unknown>)=>Promise<unknown>>(async()=>({data:read,error:null}))});
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
 await advanceReview(d as never,c,'original',{},createRuntimeBudget(()=>0));
 expect(m.cancel).toHaveBeenCalledExactlyOnceWith('original');
 expect(d.rpc).toHaveBeenLastCalledWith('publish_monitor_review_step',expect.objectContaining({p_reason:'BALANCE_LOW'}));
});
it('cron prepares work but defers model execution outside the cron response',async()=>{
 const d={rpc:vi.fn(async(name:string)=>({data:name==='publish_monitor_review_claim'?[c]:{allowed:true,executionId:'original',state:'prepared'},error:null}))};
 const defer=vi.fn();expect(await runWeeklyReviews(d as never,{env:{},defer,budget:createRuntimeBudget(()=>0)},100,()=>0)).toMatchObject({claimed:1,scheduled:1});
 expect(defer).toHaveBeenCalledOnce();expect(m.execute).not.toHaveBeenCalled();
});

it('an expired native owner resumes its exact saved epoch/cursor once',async()=>{
 m.execute.mockResolvedValueOnce({state:'waiting_resume',cursor:2,epoch:1}).mockResolvedValueOnce({state:'completed'});
 const d=db({allowed:true,executionId:'original',state:'interrupted'});
 await advanceReview(d as never,c,'original',{},createRuntimeBudget(()=>0));
 expect(m.execute).toHaveBeenCalledTimes(2);
 expect(m.execute).toHaveBeenLastCalledWith('original',undefined,{executionId:'original',cursor:2,epoch:1});
});

it.each([false,true])('before the review migration, a missing RPC is safe only with the feature off (%s)',async enabled=>{
 m.settings.mockResolvedValue({enabled});
 const d={rpc:vi.fn(async()=>({data:null,error:{code:'PGRST202'}}))};
 const pending=runWeeklyReviews(d as never,{env:{},defer:vi.fn(),budget:createRuntimeBudget(()=>0)},100,()=>0);
 if(enabled)await expect(pending).rejects.toThrow('PUBLISH_MONITOR_REVIEW_CLAIM_FAILED');
 else expect(await pending).toMatchObject({claimed:0,scheduled:0,failed:0,enabled:false});
 expect(m.prepare).not.toHaveBeenCalled();expect(m.execute).not.toHaveBeenCalled();
});

it.each([180_000,240_000])('a deferred callback shares the original invocation budget after %i ms',async elapsed=>{
 let time=0;const budget=createRuntimeBudget(()=>time);
 const d={rpc:vi.fn(async(name:string)=>({data:name==='publish_monitor_review_claim'?[c]:{allowed:true,executionId:'original',state:'prepared'},error:null}))};
 const work:Array<()=>Promise<void>>=[];
 await runWeeklyReviews(d as never,{env:{},defer:task=>work.push(task),budget},240_000,()=>time);
 time=elapsed;await work[0]!();
 if(elapsed===240_000){expect(m.execute).not.toHaveBeenCalled();expect(m.executor).not.toHaveBeenCalled();}
 else{
  expect(m.executor.mock.calls[0]![0].budget).toBe(budget);
  expect(m.executor.mock.calls[0]![0].budget.modelCallTimeout(240_000)).toBe(85_000);
  expect(m.execute).toHaveBeenCalledOnce();
 }
});
it('a transient policy failure leaves the same weekly claim recoverable instead of skipping the week',async()=>{
 const d=db({allowed:true,executionId:null,state:null});m.policy.mockRejectedValueOnce(new Error('TEMPORARY_DATABASE_FAILURE'));
 await expect(prepareReview(d as never,c,{})).rejects.toThrow('TEMPORARY_DATABASE_FAILURE');
 expect(d.rpc.mock.calls.some(([,args])=>(args as {p_action?:string}).p_action==='skip')).toBe(false);
 expect(m.prepare).not.toHaveBeenCalled();
 expect(await prepareReview(d as never,c,{})).toBe('existing');
 expect(m.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId:c.requestId,sessionId:c.sessionId}));
});
it('an ambiguous admission response is observed by its original id without a replacement admission or skip',async()=>{
 let observed=0;
 const d={rpc:vi.fn(async()=>({data:{allowed:true,executionId:observed++?'original':null,state:'prepared'},error:null}))};
 m.prepare.mockRejectedValueOnce(new Error('AMBIGUOUS_ADMISSION_RESPONSE'));
 await expect(prepareReview(d as never,c,{})).rejects.toThrow('AMBIGUOUS_ADMISSION_RESPONSE');
 expect(await prepareReview(d as never,c,{})).toBe('original');expect(m.prepare).toHaveBeenCalledOnce();
 expect(d.rpc.mock.calls).toHaveLength(2);expect(m.execute).not.toHaveBeenCalled();
});

it('terminal cap errors free a five-claim batch for later users without dispatching models',async()=>{
 const claims=Array.from({length:6},(_,i)=>({...c,
  id:'10000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  requestId:'20000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  actorId:'30000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  sessionId:'40000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  maxCostUsd:i===5?'0.3':'0.1'}));
 let pending=[...claims];
 const d={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='publish_monitor_review_claim')return {data:pending.slice(0,Number(args.p_limit)),error:null};
  if(args.p_action==='skip')pending=pending.filter(row=>row.id!==args.p_id);
  return {data:{allowed:true,executionId:null,state:null},error:null};
 })};
 m.prepare.mockImplementation(async(input:{requestId:string})=>{
  const claim=claims.find(row=>row.requestId===input.requestId)!;
  // Actual admission validator: a positive frozen cap cannot buy the required two calls.
  capReviewAdmission({maxTurns:6,maxToolCalls:5,ownPosts:true},{contractVersion:'bill2.v2',
   sourceHash:'original',rules:{creditsPerUsd:'100',multiplier:'6'},
   callPolicy:[{upperUsd:'0.1'}],limits:{maxCalls:6}} as never,{id:claim.id,token:claim.token,maxCostUsd:claim.maxCostUsd});
  return {executionId:'later-user'};
 });
 const defer=vi.fn(),options={env:{},defer,budget:createRuntimeBudget(()=>0)};
 expect(await runWeeklyReviews(d as never,options,100,()=>0)).toMatchObject({claimed:5,skipped:5,failed:0,scheduled:0});
 expect(pending.map(row=>row.id)).toEqual([claims[5]!.id]);
 expect(d.rpc.mock.calls.filter(([,args])=>args.p_action==='skip').map(([,args])=>args.p_reason))
  .toEqual(Array(5).fill('CONFIGURATION_REQUIRED'));
 expect(await runWeeklyReviews(d as never,options,100,()=>0)).toMatchObject({claimed:1,scheduled:1,failed:0});
 expect(defer).toHaveBeenCalledOnce();expect(m.execute).not.toHaveBeenCalled();
});
it.each(['PUBLISH_MONITOR_REVIEW_UNAVAILABLE','RUNTIME_STAGING_MODEL_DENIED','RUNTIME_STAGING_MODEL_NOT_APPROVED'])(
 'an explicit review/model configuration refusal is skipped (%s)',async code=>{
 const d=db({allowed:true,executionId:null,state:null});
 m.prepare.mockRejectedValueOnce(new Error(code));
 expect(await prepareReview(d as never,c,{})).toBe(null);
 expect(d.rpc).toHaveBeenLastCalledWith('publish_monitor_review_step',expect.objectContaining({
  p_action:'skip',p_reason:'CONFIGURATION_REQUIRED'}));
 expect(m.execute).not.toHaveBeenCalled();
});
