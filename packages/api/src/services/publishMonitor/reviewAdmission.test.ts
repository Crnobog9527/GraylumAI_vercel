/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {admissionActor,capReviewAdmission} from './reviewAdmission';
const review={id:'11111111-1111-4111-8111-111111111111',token:'22222222-2222-4222-8222-222222222222',maxCostUsd:'0.005'};
it('caps native BILL2 calls and budget in exact decimals before any claim or paid request',()=>{
 const context={maxTurns:6,maxToolCalls:5,ownPosts:true};
 const billing={contractVersion:'bill2.v2',sourceHash:'old',callPolicy:[{upperUsd:'0.001'}],
  rules:{creditsPerUsd:'100',multiplier:'6'},limits:{maxCalls:6,costUsd:'0.006',maxPreDeduct:4}};
 capReviewAdmission(context,billing as never,review);
 expect(context).toMatchObject({maxTurns:5,maxToolCalls:4,weeklyReview:review});
 expect(billing.limits).toMatchObject({maxCalls:5,costUsd:'0.005000000000',maxPreDeduct:3});
 expect(billing.sourceHash).not.toBe('old');
 expect(()=>capReviewAdmission(context,billing as never,{...review,maxCostUsd:'0.001'})).toThrow('PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW');
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
