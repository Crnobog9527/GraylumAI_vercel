/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
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
