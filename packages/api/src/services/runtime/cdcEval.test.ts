/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();
 return {...actual,readFileSync:vi.fn(actual.readFileSync)};
});
import {budget,CAP_NANO,measure,quote} from '../../../../../scripts/cdc-b2-eval/policy';
import {openRouterBound} from '../bill2/openRouterPolicy';
function state(nano=0){let value={calls:{mentor:0,organizer:0},nano,pending:false};
 return {read:()=>structuredClone(value),write:(v:typeof value)=>{value=structuredClone(v);}};}
it('reserves before dispatch, keeps unknown costs reserved, refuses repeat and over-cap attempts',()=>{
 const s=state(),b=budget(s.read,s.write);const settle=b.reserve('mentor',100000000);
 expect(s.read()).toMatchObject({nano:100000000,pending:true,calls:{mentor:1}});
 expect(()=>b.reserve('organizer',1)).toThrow('CDC_BUDGET_STOP');settle(.01);
 expect(s.read()).toMatchObject({nano:10000000,pending:false});expect(()=>settle(0)).toThrow('CDC_LEDGER_CHANGED');
 const failed=b.reserve('organizer',10000);expect(()=>failed(NaN)).toThrow('CDC_COST_UNKNOWN');
 expect(()=>b.reserve('mentor',1)).toThrow('CDC_BUDGET_STOP');expect(s.read().pending).toBe(true);
 const cap=state(CAP_NANO);expect(()=>budget(cap.read,cap.write).reserve('mentor',1)).toThrow('CDC_BUDGET_STOP');
});
it('enforces separate call caps, reserves uncached prices, and rejects profile drift before sending',()=>{
 const s=state();s.write({calls:{mentor:70,organizer:0},nano:0,pending:false});
 expect(()=>budget(s.read,s.write).reserve('mentor',1)).toThrow('CDC_BUDGET_STOP');
 const q=quote('mentor','10000000-0000-4000-8000-000000000001');
 const body={model:q.model,max_tokens:8192,store:false,stream:true,stream_options:{include_usage:true},reasoning_effort:'low',messages:[],
  provider:openRouterBound(q.providerLimits,8192).routing};
 const raw=JSON.stringify(body),m=measure(raw,'mentor');
 expect(m.promptTokensUpper).toBe(Buffer.byteLength(raw)+8192);
 expect(Number(m.reserveUsd)).toBeCloseTo((m.promptTokensUpper*2.5+8192*10)/1e6,10);
 expect(()=>measure(JSON.stringify({...body,max_tokens:8193}),'mentor')).toThrow('CDC_REQUEST_PROFILE');
 expect(()=>measure(JSON.stringify({...body,reasoning_effort:'high'}),'mentor')).toThrow('CDC_REASONING_PROFILE');
});

it('final third round reserves against both prior settled costs, never against a fresh nine-dollar balance',async()=>{
 const {thirdRound}=await import('../../../../../scripts/cdc-b2-eval/thirdRound');
 expect(thirdRound).toMatchObject({round:3,priorNano:1955565146,priorOfficialUsd:1.95556514,remainingNano:7044434854});
 const s=state(thirdRound.priorNano),b=budget(s.read,s.write);
 expect(()=>b.reserve('mentor',thirdRound.remainingNano+1)).toThrow('CDC_BUDGET_STOP');
 const settle=b.reserve('mentor',thirdRound.remainingNano);settle(.01);
 expect(s.read().nano).toBe(thirdRound.priorNano+10000000);
 expect(thirdRound.priorNano).toBeGreaterThanOrEqual(thirdRound.priorOfficialUsd*1e9);
});

it('rejects changed historical evidence, unsettled costs and roster or Skill drift',async()=>{
 const {verifyRoundEvidence}=await import('../../../../../scripts/cdc-b2-eval/secondRound');
 const {hash}=await import('../../../../../scripts/cdc-b2-eval/policy');
 const plan={groups:[{turns:['synthetic']}],moduleSkill:{content:'synthetic fixture'}};
 const manifest=Buffer.from(JSON.stringify({inputHash:'fixture'}));
 const input=Buffer.from(JSON.stringify(plan));
 const ledger=Buffer.from(JSON.stringify({calls:{mentor:70,organizer:30},nano:1955565146,pending:false}));
 const evidence={ledger,manifest,input};
 const identity={priorLedgerHash:hash(ledger),priorInputHash:hash(input),priorNano:1955565146,
  previousManifest:hash(JSON.stringify(JSON.parse(manifest.toString())))};
 expect(()=>verifyRoundEvidence(plan,evidence,identity)).not.toThrow();
 expect(()=>verifyRoundEvidence(plan,{...evidence,ledger:Buffer.from('{}')},identity)).toThrow('CDC_PRIOR_LEDGER_CHANGED');
 expect(()=>verifyRoundEvidence(plan,{...evidence,manifest:Buffer.from('{}')},identity)).toThrow('CDC_PRIOR_MANIFEST_CHANGED');
 expect(()=>verifyRoundEvidence(plan,{...evidence,input:Buffer.from('{}')},identity)).toThrow('CDC_PRIOR_INPUT_CHANGED');
 for(const delta of [{pending:true},{nano:1},{calls:{mentor:69,organizer:30}},{calls:{mentor:70,organizer:29}}]){
  const changed=Buffer.from(JSON.stringify({...JSON.parse(ledger.toString()),...delta}));
  expect(()=>verifyRoundEvidence(plan,{...evidence,ledger:changed},{...identity,priorLedgerHash:hash(changed)}))
   .toThrow('CDC_PRIOR_COST_UNKNOWN');
 }
 expect(()=>verifyRoundEvidence({...plan,groups:[]},evidence,identity)).toThrow('CDC_ROSTER_OR_SKILL_CHANGED');
 expect(()=>verifyRoundEvidence({...plan,moduleSkill:{}},evidence,identity)).toThrow('CDC_ROSTER_OR_SKILL_CHANGED');
});
it('third-round verifier checks both historical rounds in order',async()=>{
 // Real history is private and intentionally absent from test fixtures. A missing first ledger
 // must fail before any second-round read; filesystem mocking leaves paid boundaries untouched.
 const fs=await import('node:fs');
 const spy=vi.mocked(fs.readFileSync);spy.mockClear();
 spy.mockImplementationOnce(()=>{throw new Error('first history missing');});
 try{
  const {verifyPriorRounds}=await import('../../../../../scripts/cdc-b2-eval/thirdRound');
  expect(()=>verifyPriorRounds({groups:[],moduleSkill:{}})).toThrow('first history missing');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(String(spy.mock.calls[0]?.[0])).toMatch(/freeze-07\/live\/ledger.json$/);
 }finally{spy.mockClear();}
});
