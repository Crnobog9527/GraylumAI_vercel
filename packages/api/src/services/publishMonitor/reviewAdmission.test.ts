/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {admissionActor,capReviewAdmission} from './reviewAdmission';
const review={id:'11111111-1111-4111-8111-111111111111',token:'22222222-2222-4222-8222-222222222222',maxCostUsd:'0.005'};
const policy=(requestUsd='0.001')=>({upperUsd:'9',inputLimit:196608,outputLimit:32768,
 providerLimits:{providerSlug:'synthetic',contextTokens:1000000,promptUsdPerMillion:'0',completionUsdPerMillion:'0',requestUsd},
 payg:{maxBytes:196608,templateTokens:4096,marginTokens:4096}});
const context=()=>({maxTurns:6,maxToolCalls:5,ownPosts:true,maxOutputTokens:1000,purposeBudget:{inputBytes:32000}});
it('caps review calls at three and freezes the exact bounded request budget before any paid request',()=>{
 const ctx=context();
 const billing={contractVersion:'bill2.v2',sourceHash:'old',callPolicy:[policy()],
  rules:{creditsPerUsd:'100',multiplier:'6'},limits:{maxCalls:6,costUsd:'54',maxPreDeduct:32400}};
 capReviewAdmission(ctx,billing as never,review);
 expect(ctx).toMatchObject({maxTurns:3,maxToolCalls:2,weeklyReview:review});
 expect(billing.limits).toMatchObject({maxCalls:3,costUsd:'0.003000000000',maxPreDeduct:2});
 expect(billing.sourceHash).not.toBe('old');
 expect(()=>capReviewAdmission(ctx,billing as never,{...review,maxCostUsd:'0.001'})).toThrow('PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW');
});
it('a rejected cap leaves the budget, context and approved prices untouched',()=>{
 const ctx=context();const billing={contractVersion:'bill2.v2',sourceHash:'old',callPolicy:[policy('0.2')],
  rules:{creditsPerUsd:'100',multiplier:'6'},limits:{maxCalls:3,costUsd:'27',maxPreDeduct:16200}};
 const original=structuredClone({ctx,billing});
 expect(()=>capReviewAdmission(ctx,billing as never,{...review,maxCostUsd:'0.30'})).toThrow('PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW');
 expect({ctx,billing}).toEqual(original);
});
it('requires the frozen input, output and PAYG overhead rather than inventing a cheaper quote',()=>{
 const billing={contractVersion:'bill2.v2',callPolicy:[policy()]};
 for(const ctx of [{...context(),purposeBudget:undefined},{...context(),maxOutputTokens:undefined}])
  expect(()=>capReviewAdmission(ctx,billing as never,review)).toThrow('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
 expect(()=>capReviewAdmission(context(),{...billing,callPolicy:[{...policy(),payg:undefined}]} as never,review))
  .toThrow('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
});
it('ordinary authentication stays required; a service review must own an allowed SQL lease',async()=>{
 const auth={auth:{getUser:vi.fn(async()=>({data:{user:null},error:null}))}};
 await expect(admissionActor(auth as never,{} as never)).rejects.toThrow('RUNTIME_AUTH_REQUIRED');
 const rpc=vi.fn(async()=>({data:{allowed:false,actorId:'actor'},error:null}));
 await expect(admissionActor(auth as never,{rpc} as never,review)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_DENIED');
 expect(rpc).toHaveBeenCalledWith('publish_monitor_review_step',expect.objectContaining({p_id:review.id,p_token:review.token}));
 rpc.mockResolvedValue({data:{allowed:true,actorId:'actor'},error:null});
 expect(await admissionActor(auth as never,{rpc} as never,review)).toBe('actor');
 expect(auth.auth.getUser).toHaveBeenCalledTimes(1);
});
