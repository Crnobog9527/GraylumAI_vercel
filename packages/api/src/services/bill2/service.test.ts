/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const rebate=vi.hoisted(()=>vi.fn(async(_args:Record<string,unknown>)=>({status:'already_applied'})));
vi.mock('../invitationRebate',()=>({applyInvitationRebateForSpend:rebate}));
import { authoritativeBilling } from './service';
import { localFixtureAdapter } from './fixtureAdapter';
beforeEach(()=>rebate.mockClear());
it('passes only actual terminal spend and the original idempotent identity to the existing downstream',async()=>{
 const actor=randomUUID(),run=randomUUID(),pre=randomUUID(),client={};const view={id:run,preDeductId:pre,state:'settled',chargedCredits:7};
 const api=authoritativeBilling({admin:{rpc:async()=>({data:view,error:null})},actor:async()=>actor,adapter:localFixtureAdapter('http://127.0.0.1:1'),rebateClient:client});
 await api.finalizeRun(run);await api.finalizeRun(run);
 expect(rebate.mock.calls).toHaveLength(2);for(const args of rebate.mock.calls)expect(args[0]).toMatchObject({inviteeId:actor,preDeductId:pre,consumedCredits:7,supabaseAdmin:client});
 // This asserts adapter identity only. Original helper/RPC suites prove downstream idempotence.
});
it.each([{state:'refunded',chargedCredits:0},{state:'settled',chargedCredits:0},{state:'unknown',chargedCredits:null}])('never rebates a release, zero spend or unresolved reservation: %j',async state=>{
 const api=authoritativeBilling({admin:{rpc:async()=>({data:state,error:null})},actor:async()=>randomUUID(),adapter:localFixtureAdapter('http://127.0.0.1:1'),rebateClient:{}});await api.finalizeRun(randomUUID());expect(rebate).not.toHaveBeenCalled();
});
