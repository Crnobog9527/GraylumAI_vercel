/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({quote:vi.fn(),run:vi.fn(),rows:[] as unknown[]}));
vi.mock('./admission/admissionConfiguration',()=>({readAdmissionConfiguration:async()=>({data:m.rows,error:null})}));
vi.mock('./admission/newWorkGate',()=>({readAdmissionSettings:async()=>({ok:true,identityGuard:true})}));
vi.mock('./quote',async original=>({...(await original<object>()),chatQuote:m.quote}));
vi.mock('./agent/runner',()=>({runRuntime:m.run}));
vi.mock('./provider/openRouterAdapter',()=>({openRouterAdapter:()=>({})}));
import {TurnStop} from './call';
import {runReviewTurn,type ReviewClaimInput} from './review';
const claim:ReviewClaimInput={id:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',
 sessionId:'55555555-5555-4555-8555-555555555555',requestId:'44444444-4444-4444-8444-444444444444',
 modelId:'66666666-6666-4666-8666-666666666666',maxCostUsd:'1',cadence:'weekly',attempt:1};
const QUOTE={modelId:claim.modelId,model:'anthropic/sonnet',q:'100',multiplier:'6',upperUsd:'0.2',pricing:undefined,
 providerLimits:{providerSlug:'x',contextTokens:200000,promptUsdPerMillion:'3',completionUsdPerMillion:'15',requestUsd:'0'},
 identity:{account:'acct'},reasoning:{},outputLimit:8000,inputLimit:32000,credential:async()=>'key'};
const tomb={sessionTombstoned:false,accountErasing:false,voiceSourceRevoked:false};
type Calls=Array<[string,Record<string,unknown>]>;
function deps(options:{openError?:string;gate?:{ok:boolean;reason?:string}}={}){
 const calls:Calls=[];
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push([name,args]);
  if(name==='turn_open')return options.openError?{data:null,error:{message:options.openError}}
   :{data:{turnId:9,state:'running',replay:false,reservedCredits:120,reservedUsd:0.2,history:[],replyLanguage:null},error:null};
  if(name==='turn_close')return {data:{turnId:9,closeKind:args.p_close_kind,chargedCredits:80,absorbedCredits:0,settlement:'done',replay:false,...tomb},error:null};
  return {data:{state:'running',...tomb},error:null};
 });
 const admin={rpc} as never;
 return {calls,deps:{admin,clients:{write:{rpc},read:{rpc,from:()=>({})}} as never,slots:{} as never,
  newWork:{message:async()=>options.gate??{ok:true},calls:async()=>({ok:true})} as never}};
}
const of=(calls:Calls,name:string)=>calls.filter(c=>c[0]===name).map(c=>c[1]);
beforeEach(()=>{vi.clearAllMocks();
 m.rows=[{key:'core_path_v2',value:{enabled:true,decisionUpperUsd:'0.01',stopLoss:{limitUsd:100,p:4,poolSize:16,uFastUsd:1,uBigUsd:5}}},
  {key:'billing_payg_start_thresholds',value:{version:'1',thresholds:[{model:'anthropic/sonnet',purpose:'ordinary',typicalUsd:'0.1'}]}}];
 m.quote.mockResolvedValue(QUOTE);m.run.mockResolvedValue('本周表现：……');});

it('opens one kind=review turn that freezes one model call under the review cap, writes the reading and settles once',async()=>{
 const d=deps();
 const result=await runReviewTurn(d.deps,claim,{kind:'my_posts'},async()=>true);
 expect(result).toEqual({kind:'done',turnId:9,closeKind:'completed',delivered:true});
 const [opened]=of(d.calls,'turn_open');
 expect(opened).toMatchObject({p_kind:'review',p_session_id:claim.sessionId,p_request_id:claim.requestId});
 expect(opened!.p_policy).toMatchObject({limits:{model:1,paidTools:0,freeTools:0,decisions:0},modelUpperUsd:'0.2',minCredits:60,
  review:{mode:'weekly',id:claim.id,cadence:'weekly',attempt:1,maxCostUsd:'1'}});
 expect(opened!.p_policy).not.toHaveProperty('holdCredits');
 const [closed]=of(d.calls,'turn_close');
 expect(closed).toMatchObject({p_close_kind:'completed',p_delivered:true,p_refund_all:false});
 expect(closed!.p_messages).toEqual([expect.objectContaining({role:'user'}),{role:'assistant',content:'本周表现：……'}]);
 // The data (private) is not copied into the saved message; the request carries it only to the model.
 expect(JSON.stringify(closed!.p_messages)).not.toContain('my_posts');
 expect(m.run).toHaveBeenCalledWith(expect.objectContaining({maxTurns:1,tools:[],maxOutputTokens:2000,model:'anthropic/sonnet',
  input:expect.stringContaining('"kind":"my_posts"')}));
});
it('a call bound above the review cap opens nothing and ends the week as a configuration skip',async()=>{
 const d=deps();
 expect(await runReviewTurn(d.deps,{...claim,maxCostUsd:'0.1'},{},async()=>true)).toEqual({kind:'skipped',reason:'CONFIGURATION_REQUIRED'});
 expect(of(d.calls,'turn_open')).toHaveLength(0);
 expect(m.run).not.toHaveBeenCalled();
});
it('a model that is not admitted, or no start threshold for it, is a configuration skip; other quote failures are deferred',async()=>{
 m.quote.mockRejectedValueOnce(Object.assign(new Error('x'),{code:'TURN_MODEL_NOT_ADMITTED'}));
 expect((await runReviewTurn(deps().deps,claim,{},async()=>true)).kind).toBe('deferred');
 const {QuoteError}=await import('./quote');
 m.quote.mockRejectedValueOnce(new QuoteError('TURN_MODEL_NOT_ADMITTED'));
 expect(await runReviewTurn(deps().deps,claim,{},async()=>true)).toEqual({kind:'skipped',reason:'CONFIGURATION_REQUIRED'});
 m.rows=m.rows.filter(row=>(row as {key:string}).key!=='billing_payg_start_thresholds');
 expect(await runReviewTurn(deps().deps,claim,{},async()=>true)).toEqual({kind:'skipped',reason:'CONFIGURATION_REQUIRED'});
});
it('the core-path switch off, or the administrator\'s pause, opens nothing',async()=>{
 m.rows=m.rows.map(row=>(row as {key:string}).key==='core_path_v2'?{key:'core_path_v2',value:{enabled:false}}:row);
 expect(await runReviewTurn(deps().deps,claim,{},async()=>true)).toEqual({kind:'skipped',reason:'CONFIGURATION_REQUIRED'});
 const paused=deps({gate:{ok:false,reason:'paused'}});
 m.rows=[...m.rows];
 const result=await runReviewTurn(paused.deps,claim,{},async()=>true);
 expect(result.kind==='skipped'||result.kind==='deferred').toBe(true);
});
it('a balance that cannot start the review ends the week as "余额不足" with nothing held',async()=>{
 const d=deps({openError:'TURN_INSUFFICIENT_CREDITS'});
 expect(await runReviewTurn(d.deps,claim,{},async()=>true)).toEqual({kind:'skipped',reason:'BALANCE_LOW'});
 expect(of(d.calls,'turn_close')).toHaveLength(0);
});
it('a stop-loss refusal at the open is only deferred, the week is not lost',async()=>{
 expect(await runReviewTurn(deps({openError:'STOP_LOSS_REACHED'}).deps,claim,{},async()=>true)).toEqual({kind:'deferred',code:'STOP_LOSS_REACHED'});
});
it('a review switched off before the paid call opens nothing',async()=>{
 const d=deps();
 expect(await runReviewTurn(d.deps,claim,{},async()=>false)).toEqual({kind:'deferred',code:'REVIEW_NOT_AUTHORIZED'});
 expect(of(d.calls,'turn_open')).toHaveLength(0);
});
it('a pause for credits mid-turn closes it at once, refunds the freeze and ends the week as "余额不足"',async()=>{
 m.run.mockRejectedValueOnce(new TurnStop('TURN_PAUSED_FOR_CREDITS'));
 const d=deps();
 expect(await runReviewTurn(d.deps,claim,{},async()=>true)).toEqual({kind:'skipped',reason:'BALANCE_LOW'});
 expect(of(d.calls,'turn_close')[0]).toMatchObject({p_close_kind:'failed',p_refund_all:true,p_delivered:false});
});
it('any other failure, or an empty reading, delivers and charges nothing: the turn closes failed with a full refund',async()=>{
 m.run.mockRejectedValueOnce(new Error('provider down'));
 const d=deps();
 expect(await runReviewTurn(d.deps,claim,{},async()=>true)).toEqual({kind:'done',turnId:9,closeKind:'failed',delivered:false});
 expect(of(d.calls,'turn_close')[0]).toMatchObject({p_close_kind:'failed',p_refund_all:true,p_delivered:false,p_failure_code:'turn_failed'});
 m.run.mockResolvedValueOnce('   ');
 const e=deps();
 expect(await runReviewTurn(e.deps,claim,{},async()=>true)).toMatchObject({kind:'done',closeKind:'failed',delivered:false});
 expect(of(e.calls,'turn_close')[0]).toMatchObject({p_close_kind:'failed',p_refund_all:true});
});
it('an unknown cost closes as interrupted without a refund; an erasure closes as erased',async()=>{
 m.run.mockRejectedValueOnce(new TurnStop('TURN_CALL_UNKNOWN'));
 const d=deps();
 expect(await runReviewTurn(d.deps,claim,{},async()=>true)).toMatchObject({closeKind:'interrupted',delivered:false});
 expect(of(d.calls,'turn_close')[0]).toMatchObject({p_close_kind:'interrupted',p_refund_all:false});
 m.run.mockRejectedValueOnce(new TurnStop('TURN_TOMBSTONED'));
 const e=deps();
 expect(await runReviewTurn(e.deps,claim,{},async()=>true)).toMatchObject({closeKind:'erased'});
});
it('a source account disconnected while the text was written: nothing is saved, the turn closes as erased', async () => {
  const d = deps();
  const result = await runReviewTurn(d.deps, claim, { kind: 'my_posts' }, async () => true, async () => false);
  expect(result).toEqual({ kind: 'done', turnId: 9, closeKind: 'erased', delivered: false });
  expect(of(d.calls, 'turn_close')[0]).toMatchObject({ p_close_kind: 'erased', p_delivered: false, p_messages: [] });
});
