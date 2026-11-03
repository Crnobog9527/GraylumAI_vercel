/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {logger} from '../../lib/logger';
const m=vi.hoisted(()=>({run:vi.fn(),pack:vi.fn(),settings:vi.fn(),close:vi.fn(),rows:vi.fn(),build:vi.fn(),save:vi.fn()}));
vi.mock('../turn/review',()=>({runReviewTurn:m.run}));
vi.mock('../turn/agent/workspacePosts',()=>({resolvePostSource:m.pack}));
vi.mock('../turn/db',()=>({turnClients:(db:unknown)=>({write:db,read:db}),turnDatabase:()=>({close:m.close})}));
vi.mock('../turn/admission/newWorkGate',()=>({newWorkGate:()=>({})}));
vi.mock('../turn/limiter',()=>({redisCounterStore:()=>({})}));
vi.mock('./reviewSettings',()=>({readReviewSettings:m.settings}));
vi.mock('./coach/rows',()=>({readPackRows:m.rows,COACH_READ_WEEKS:52}));
vi.mock('./coach/pack',()=>({buildPack:m.build}));
vi.mock('./coach/persist',()=>({saveCoachLedger:m.save}));
import {createRuntimeBudget} from '../turn/settings/budget';
import {readFileSync} from 'node:fs';
import {advanceReview,claimSchema,prepareReview,runWeeklyReviews,type ReviewClaim,type ReviewStep} from './reviews';
const c:ReviewClaim={id:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',
 token:'33333333-3333-4333-8333-333333333333',requestId:'44444444-4444-4444-8444-444444444444',
 sessionId:'55555555-5555-4555-8555-555555555555',modelId:'66666666-6666-4666-8666-666666666666',maxCostUsd:'0.100000000000'};
const PACK={kind:'my_posts',status:'available',review:{rows:[]},window_days:90};
const options=(defer=vi.fn()):ReviewStep=>({env:{},defer,budget:createRuntimeBudget(),turn:{} as never});
type Calls=Array<[string,Record<string,unknown>]>;
/** A database whose step answers come from `steps` (by action) and whose other RPCs return `other`. */
function database(steps:Record<string,Record<string,unknown>>,extra:Record<string,unknown>={}){
 const calls:Calls=[];
 const other:Record<string,unknown>={publish_monitor_post_window:14,...extra};
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push([name,args]);
  if(name==='publish_monitor_review_step'){
   const answer=steps[String(args.p_action)]??steps.default;
   return {data:{allowed:true,actorId:c.actorId,turnId:null,state:null,...answer},error:null};
  }
  return {data:name in other?other[name]:true,error:null};
 });
 return {calls,rpc,db:{rpc} as never};
}
const stepActions=(calls:Calls)=>calls.filter(x=>x[0]==='publish_monitor_review_step').map(x=>[x[1].p_action,x[1].p_reason]);
beforeEach(()=>{vi.clearAllMocks();m.settings.mockResolvedValue({enabled:true});m.pack.mockResolvedValue(PACK);m.close.mockResolvedValue({});
 m.run.mockResolvedValue({kind:'done',turnId:9,closeKind:'completed',delivered:true});});

it('a review already completed, skipped, retried or waiting on its cost is left alone',async()=>{
 for(const state of ['completed','failed','cost_pending','retrying']){
  const d=database({default:{state}});
  expect(await prepareReview(d.db,c)).toBe(false);
  expect(stepActions(d.calls)).toEqual([['observe',null]]);
 }
});
it('a review turn past its deadline is closed as interrupted and then skipped, with no new admission',async()=>{
 const d=database({observe:{state:'running',turnId:7,expired:true},default:{}});
 expect(await prepareReview(d.db,c)).toBe(false);
 expect(m.close).toHaveBeenCalledWith(expect.objectContaining({actorId:c.actorId,turnId:7,kind:'interrupted',delivered:false}));
 expect(stepActions(d.calls)).toEqual([['observe',null],['skip','RUNTIME_INTERRUPTED']]);
 expect(m.run).not.toHaveBeenCalled();
});
it('an expired review that never opened a turn is skipped without closing anything',async()=>{
 const d=database({observe:{expired:true},default:{}});
 expect(await prepareReview(d.db,c)).toBe(false);
 expect(m.close).not.toHaveBeenCalled();
 expect(stepActions(d.calls)).toEqual([['observe',null],['skip','RUNTIME_INTERRUPTED']]);
});
it('turning the feature off closes a running turn and skips; nothing new is paid for',async()=>{
 const d=database({observe:{allowed:false,state:'running',turnId:7},default:{}});
 expect(await prepareReview(d.db,c)).toBe(false);
 expect(m.close).toHaveBeenCalledWith(expect.objectContaining({turnId:7,kind:'interrupted'}));
 expect(stepActions(d.calls)).toEqual([['observe',null],['skip','DISABLED']]);
});
it('a turn still running (another invocation) is not started again',async()=>{
 const d=database({observe:{state:'running',turnId:7}});
 expect(await prepareReview(d.db,c)).toBe(false);
 expect(stepActions(d.calls)).toEqual([['observe',null]]);
});
it('a claim without a model or a cap is a configuration skip and logs only its allowlisted code',async()=>{
 const warn=vi.spyOn(logger,'warn').mockImplementation(()=>undefined);
 const d=database({observe:{},default:{}});
 expect(await prepareReview(d.db,{...c,modelId:null})).toBe(false);
 expect(await prepareReview(d.db,{...c,maxCostUsd:'0'})).toBe(false);
 expect(stepActions(d.calls)).toEqual([['observe',null],['skip','CONFIGURATION_REQUIRED'],['observe',null],['skip','CONFIGURATION_REQUIRED']]);
 expect(warn).toHaveBeenCalledWith('billing','weekly_review_configuration_refused',{reviewId:c.id,code:'PUBLISH_MONITOR_REVIEW_UNAVAILABLE'});
});
it('a healthy new claim is ready to start',async()=>{
 expect(await prepareReview(database({observe:{}}).db,c)).toBe(true);
});

it('advance saves the code-computed pack, runs one turn with the frozen claim, and observes a delivered review',async()=>{
 const d=database({default:{}});
 await advanceReview(d.db,c,options());
 expect(m.pack).toHaveBeenCalledWith(expect.anything(),c.actorId,{kind:'workspace_posts_request',windowDays:90,entitled:false,review:true});
 expect(d.calls.find(x=>x[0]==='publish_monitor_review_save_pack')![1]).toEqual({p_id:c.id,p_token:c.token,p_pack:PACK});
 expect(m.run).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:c.id,actorId:c.actorId,sessionId:c.sessionId,
  requestId:c.requestId,modelId:c.modelId,maxCostUsd:c.maxCostUsd}),PACK,expect.any(Function),expect.any(Function));
 expect(stepActions(d.calls).at(-1)).toEqual(['observe',null]);
});
it('the visibility of the pack\'s sources is asked right before the turn is saved, through the database check',async()=>{
 const d=database({default:{}},{publish_monitor_pack_visible:false});
 m.run.mockImplementationOnce(async(_deps,_claim,_pack,_authorize,visible:()=>Promise<boolean>)=>{
  expect(await visible()).toBe(false);return {kind:'deferred',code:'x'};});
 await advanceReview(d.db,c,options());
 expect(d.calls.find(x=>x[0]==='publish_monitor_pack_visible')![1]).toEqual({p_actor_id:c.actorId,p_result:PACK});
});
it('a brand review reads the coach pack of its brand and cadence, saves it wrapped like the plain pack, and runs the turn as a coach review',async()=>{
 const BUSINESS='88888888-8888-4888-8888-888888888888',CONN='99999999-9999-4999-8999-999999999999';
 m.rows.mockResolvedValue({followers:[{connectionId:CONN},{connectionId:CONN}],profile:null,facts:[],recent:[]});
 m.build.mockReturnValue({kind:'review_pack',mode:'full'});
 const d=database({default:{businessId:BUSINESS,cadence:'monthly',attempt:2}});
 await advanceReview(d.db,c,options());
 expect(m.rows).toHaveBeenCalledWith(expect.anything(),c.actorId,BUSINESS,52);
 expect(m.build).toHaveBeenCalledWith(expect.objectContaining({cadence:'monthly',businessId:BUSINESS,handbooks:expect.any(Map)}));
 const wrapped={kind:'review_pack',status:'available',window_days:90,source_connections:[CONN],review:{kind:'review_pack',mode:'full'}};
 expect(d.calls.find(x=>x[0]==='publish_monitor_review_save_pack')![1]).toEqual({p_id:c.id,p_token:c.token,p_pack:wrapped});
 expect(m.run).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({coach:true,cadence:'monthly',attempt:2}),wrapped,expect.any(Function),expect.any(Function));
 expect(m.pack).not.toHaveBeenCalled();
 await advanceReview(database({default:{businessId:BUSINESS,cadence:'weekly'}}).db,c,options());
 expect(m.rows).toHaveBeenLastCalledWith(expect.anything(),c.actorId,BUSINESS,52);
});
it('a brand review builds its pack with the handbooks of the pinned Skill package; without the setting the Map is empty',async()=>{
 const BUSINESS='88888888-8888-4888-8888-888888888888';
 m.rows.mockResolvedValue({followers:[],profile:null,facts:[],recent:[]});m.build.mockReturnValue({kind:'review_pack',mode:'full'});
 const handbook={platform:'douyin',version:'t',calibration:'draft',labels:{},funnel:[{layer:'hook',name:'h',keys:['retain_3s'],basics:true,pass:{}}]};
 const d=database({default:{businessId:BUSINESS,cadence:'weekly'}},{fusion_review_skill_file:Buffer.from(JSON.stringify(handbook)).toString('base64')});
 const env={PUBLISH_MONITOR_HANDBOOK_PACKAGE:JSON.stringify({skillId:'11111111-1111-4111-8111-111111111111',revisionId:'33333333-3333-4333-8333-333333333333',packageHash:'b'.repeat(64)})};
 await advanceReview(d.db,c,{...options(),env});
 const given=m.build.mock.calls.at(-1)![0].handbooks as Map<string,unknown>;
 expect([...given.keys()]).toEqual(['douyin']);
 expect(d.calls.some(x=>x[0]==='fusion_review_skill_file'&&x[1].p_path==='handbook/douyin.json')).toBe(true);
 m.build.mockClear();
 await advanceReview(database({default:{businessId:BUSINESS,cadence:'weekly'}}).db,c,options());
 expect((m.build.mock.calls.at(-1)![0].handbooks as Map<string,unknown>).size).toBe(0);
});
it('a delivered brand review writes its checked output to the ledger before it completes; a failed write does not undo the review',async()=>{
 const BUSINESS='88888888-8888-4888-8888-888888888888';
 m.rows.mockResolvedValue({followers:[],profile:null,facts:[],recent:[]});m.build.mockReturnValue({kind:'review_pack',mode:'full'});
 m.save.mockResolvedValue(true);
 m.run.mockResolvedValue({kind:'done',turnId:9,closeKind:'completed',delivered:true,coach:{parsed:true}});
 const d=database({default:{businessId:BUSINESS,cadence:'weekly'}});
 await advanceReview(d.db,c,options());
 expect(m.save).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:c.id}),BUSINESS,expect.objectContaining({review:{kind:'review_pack',mode:'full'}}),{parsed:true});
 const order=[...m.save.mock.invocationCallOrder,...d.rpc.mock.invocationCallOrder.filter((_,i)=>d.rpc.mock.calls[i]![0]==='publish_monitor_review_step'&&d.rpc.mock.calls[i]![1].p_action==='observe')];
 expect(order[0]).toBeLessThan(order[1]!);
 m.save.mockRejectedValue(new Error('PUBLISH_MONITOR_COACH_LEDGER_SAVE_FAILED'));
 const failed=database({default:{businessId:BUSINESS,cadence:'weekly'}});
 await advanceReview(failed.db,c,options());
 expect(stepActions(failed.calls).at(-1)).toEqual(['observe',null]);
 // a plain weekly review and a turn that delivered nothing never touch the ledger
 m.save.mockClear();
 await advanceReview(database({default:{}}).db,c,options());
 m.run.mockResolvedValue({kind:'done',turnId:9,closeKind:'interrupted',delivered:false,coach:{parsed:true}});
 await advanceReview(database({default:{businessId:BUSINESS,cadence:'weekly'}}).db,c,options());
 expect(m.save).not.toHaveBeenCalled();
});
it('a post whose title names a pillar is tagged by code before the pack is built, and the tags travel with the saved pack, not to the model',async()=>{
 const BUSINESS='88888888-8888-4888-8888-888888888888',pillars=[{key:'p1',name:'读书笔记',definition:'读书笔记'},{key:'p2',name:'穿搭灵感',definition:'穿搭灵感'}];
 const fact=(postId:string,title:string,pillarKey:string|null=null)=>({postId,title,pillarKey,pillarSource:null,platform:'tiktok'});
 m.rows.mockResolvedValue({followers:[],profile:{pillars},facts:[fact('a','【读书笔记】 x'),fact('b','没有栏目'),fact('c','【穿搭灵感】 y','p1')],
  recent:[fact('d','今天的穿搭灵感')]});
 m.build.mockReturnValue({kind:'review_pack'});
 const {readCoachPack}=await import('./reviews');
 const pack=await readCoachPack({} as never,c.actorId,BUSINESS,'weekly');
 const built=m.build.mock.calls.at(-1)![0] as {rows:{facts:Array<{postId:string;pillarKey:string|null}>;recent:Array<{postId:string;pillarKey:string|null}>}};
 expect(built.rows.facts.map(f=>[f.postId,f.pillarKey])).toEqual([['a','p1'],['b',null],['c','p1']]);
 expect(built.rows.recent.map(f=>f.pillarKey)).toEqual(['p2']);
 expect(pack.auto_tags).toEqual([{post_id:'a',pillar_key:'p1'},{post_id:'d',pillar_key:'p2'}]);
 expect(JSON.stringify(pack.review)).not.toContain('auto_tags');
});
it('the 90-day window is used only for an account whose window is that long',async()=>{
 await advanceReview(database({default:{}},{publish_monitor_post_window:90}).db,c,options());
 expect(m.pack).toHaveBeenCalledWith(expect.anything(),c.actorId,expect.objectContaining({entitled:true}));
});
it('a pack the code cannot build ends the week as a configuration skip before any model call',async()=>{
 m.pack.mockResolvedValue({kind:'unavailable'});
 const d=database({default:{}});
 await advanceReview(d.db,c,options());
 expect(m.run).not.toHaveBeenCalled();
 expect(stepActions(d.calls)).toEqual([['authorize',null],['skip','CONFIGURATION_REQUIRED']]);
});
it('a review switched off between the claim and the call is skipped as disabled, with no model call',async()=>{
 const d=database({authorize:{allowed:false},default:{}});
 await advanceReview(d.db,c,options());
 expect(m.run).not.toHaveBeenCalled();
 expect(stepActions(d.calls)).toEqual([['authorize',null],['skip','DISABLED']]);
});
it('a lost lease on saving the pack stops without a turn',async()=>{
 const d=database({default:{}},{publish_monitor_review_save_pack:false});
 await advanceReview(d.db,c,options());
 expect(m.run).not.toHaveBeenCalled();
});
it('the turn reports what ended the review: a balance skip, a deferral, an interruption, an erasure',async()=>{
 const cases:Array<[unknown,Array<unknown[]>]>=[
  [{kind:'skipped',reason:'BALANCE_LOW'},[['skip','BALANCE_LOW']]],
  [{kind:'skipped',reason:'CONFIGURATION_REQUIRED'},[['skip','CONFIGURATION_REQUIRED']]],
  [{kind:'deferred',code:'TURN_NEW_CALLS_PAUSED'},[]],
  [{kind:'done',turnId:9,closeKind:'failed',delivered:false},[['skip','RUNTIME_INTERRUPTED']]],
  [{kind:'done',turnId:9,closeKind:'interrupted',delivered:false},[['skip','RUNTIME_INTERRUPTED']]],
  [{kind:'done',turnId:9,closeKind:'erased',delivered:false},[['skip','RUNTIME_ENDED']]]];
 for(const [result,tail] of cases){
  m.run.mockResolvedValueOnce(result);
  const d=database({default:{}});
  await advanceReview(d.db,c,options());
  expect(stepActions(d.calls).slice(1)).toEqual(tail);
 }
});
it('the turn asks for authorization right before the paid call, through the review step',async()=>{
 const d=database({authorize:{allowed:true},default:{}});
 m.run.mockImplementationOnce(async(_deps,_claim,_pack,authorize:()=>Promise<boolean>)=>{
  expect(await authorize()).toBe(true);return {kind:'deferred',code:'x'};});
 await advanceReview(d.db,c,options());
 expect(stepActions(d.calls).filter(([a])=>a==='authorize')).toHaveLength(2);
});
it('an error mid-way leaves the same claim for the next batch and is only logged',async()=>{
 const warn=vi.spyOn(logger,'warn').mockImplementation(()=>undefined);
 m.run.mockRejectedValueOnce(new Error('PUBLISH_MONITOR_REVIEW_STEP_FAILED'));
 const d=database({default:{}});
 await expect(advanceReview(d.db,c,options())).resolves.toBeUndefined();
 expect(warn).toHaveBeenCalledWith('billing','weekly_review_interrupted',{reviewId:c.id,code:'PUBLISH_MONITOR_REVIEW_STEP_FAILED'});
});

it('cron prepares work but defers the model call outside the cron response',async()=>{
 const d=database({observe:{},default:{}},{publish_monitor_review_claim:[c]});
 const defer=vi.fn();
 const result=await runWeeklyReviews(d.db,options(defer),Date.now()+10_000);
 expect(result).toMatchObject({claimed:1,scheduled:1,skipped:0,failed:0,enabled:true});
 expect(m.run).not.toHaveBeenCalled();
 expect(defer).toHaveBeenCalledTimes(1);
 await defer.mock.calls[0]![0]();
 expect(m.run).toHaveBeenCalledTimes(1);
});
it('cron accepts the claims exactly as the database returns them, plain ones and the brand coach\'s',async()=>{
 const BUSINESS='88888888-8888-4888-8888-888888888888';
 const plain={...c,businessId:null,cadence:'weekly',attempt:1};
 const brand={...c,id:'77777777-7777-4777-8777-777777777777',businessId:BUSINESS,cadence:'monthly',attempt:2};
 const d=database({observe:{},default:{}},{publish_monitor_review_claim:[plain,brand]});
 const defer=vi.fn();
 expect(await runWeeklyReviews(d.db,options(defer),Date.now()+10_000)).toMatchObject({claimed:2,scheduled:2,failed:0});
 expect(defer).toHaveBeenCalledTimes(2);
});
// Claims as publish_monitor_review_claim_item() returns them: the database suite publish-monitor-coach asserts the real function's output
// has these keys and kinds of value (the old claim without the coach keys, and the brand coach's with them).
const SAMPLES:Record<string,Record<string,unknown>>=JSON.parse(readFileSync(new URL('../../../../db/tests/publish-monitor-coach/claim-samples.json',import.meta.url),'utf8'));
it('the scheduler takes claims as the database function returns them, plain and brand, and schedules each one\'s turn',async()=>{
 const claims=Object.values(SAMPLES).map((claim,i)=>({...claim,id:`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`}));
 expect(Object.keys(claimSchema.shape).sort()).toEqual([...new Set(claims.flatMap(claim=>Object.keys(claim)))].sort());
 const d=database({observe:{},default:{}},{publish_monitor_review_claim:claims});
 const defer=vi.fn();
 expect(await runWeeklyReviews(d.db,options(defer),Date.now()+10_000)).toMatchObject({claimed:2,scheduled:2,failed:0});
 for(const call of defer.mock.calls)await call[0]();
 expect(m.run).toHaveBeenCalledTimes(2);
});
it('a feature switched off still reaches existing claims; a missing claim function is only an off feature',async()=>{
 m.settings.mockResolvedValue({enabled:false});
 const d={rpc:vi.fn(async()=>({data:null,error:{code:'PGRST202'}}))} as never;
 expect(await runWeeklyReviews(d,options(),Date.now()+10_000)).toMatchObject({enabled:false,claimed:0});
 const broken={rpc:vi.fn(async()=>({data:null,error:{code:'XX000'}}))} as never;
 await expect(runWeeklyReviews(broken,options(),Date.now()+10_000)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_CLAIM_FAILED');
});
it('one claim that cannot be prepared does not hold back the rest, and nothing is claimed past the deadline',async()=>{
 const second={...c,id:'77777777-7777-4777-8777-777777777777'};
 let n=0;
 const rpc=vi.fn(async(name:string)=>{
  if(name==='publish_monitor_review_claim')return {data:[c,second],error:null};
  if(name==='publish_monitor_review_step'&&++n===1)return {data:null,error:{code:'XX000'}};
  return {data:{allowed:true,actorId:c.actorId,state:null},error:null};
 });
 const defer=vi.fn();
 const result=await runWeeklyReviews({rpc} as never,options(defer),Date.now()+10_000);
 expect(result).toMatchObject({claimed:2,failed:1,scheduled:1});
 const late=await runWeeklyReviews({rpc} as never,options(),0,()=>1);
 expect(late).toMatchObject({claimed:2,scheduled:0,skipped:0,failed:0});
});
