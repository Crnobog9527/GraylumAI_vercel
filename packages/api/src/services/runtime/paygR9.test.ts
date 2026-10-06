/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import frozen from '../../../../../docs/launch/evidence/payg-profile-20261006-r9.manifest.json';
import old from '../../../../../docs/launch/evidence/payg-profile-20261006-r8.manifest.json';
import {createR9Plan} from '../../../../../scripts/payg-profile/batch-r9';
import {createR8Plan} from '../../../../../scripts/payg-profile/batch-r8';
import drafts from '../../../../../docs/launch/evidence/payg-profile-20261006-r9.profiles-draft.json';
import {paygHostProfile} from './paygHostPolicy';
import {verifiedPlan} from '../../../../../scripts/payg-profile/executor';
let plan:ReturnType<typeof createR9Plan>;
beforeAll(()=>{plan=createR9Plan(prices);},30000);
it('preserves all 12 route bodies and bounds with new IDs, accounts known-cost UNKNOWN without retaining evidence',()=>{
 expect(plan.manifest).toEqual(frozen);expect(frozen.calls).toBe(12);expect(frozen.outputStressSamples).toBe(0);
 const previous=createR8Plan(prices);expect(previous.manifest).toEqual(old);
 expect(frozen.priorAccountedUsd).toBe('6.537562065000');
 expect(frozen.totalUsd).toBe('2.792448000000');expect(frozen.cumulativeUpperUsd).toBe('9.330010065000');
 expect(frozen.retainedEvidence).toEqual(old.retainedEvidence);
 expect(frozen.batch.previous.at(-1)).toMatchObject({manifestHash:old.manifestHash,confirmedReceiptUsd:'0.067424500000',ownerConfirmedZero:[]});
 for(const s of frozen.samples){
  const prior=old.samples.find(p=>p.id===s.id.replace(/:r9$/,':r8'))!;
  expect(s).toEqual({...prior,id:s.id});expect(s.kind).toBe('route');expect(s.reasoning).toEqual({effort:'low'});
  const request=plan.requests.find(r=>r.id===s.id)!;
  expect(request.body).toBe(previous.requests.find(r=>r.id===prior.id)!.body);
  expect(createHash('sha256').update(request.body).digest('hex')).toBe(s.requestHash);
 }
 expect(frozen.samples.filter(s=>s.approvedCap==='0.60')).toHaveLength(3);
 expect(verifiedPlan(prices,frozen,frozen.manifestHash).manifest).toEqual(frozen);
 expect(()=>verifiedPlan(prices,old,old.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
},30000);

it('drafts mark Sonnet low as a same-route transfer rather than invented direct samples',()=>{
 expect(drafts.status).toBe('DRAFT_PENDING_R9_ROUTE_EVIDENCE');
 for(const p of drafts.profiles){expect(paygHostProfile.safeParse(p).success).toBe(true);expect(p.expiresAt).toBe('2026-10-13T00:00:00Z');}
 const p=drafts.profiles.find(p=>p.model.startsWith('anthropic/'))!;
 expect(p.reasoningVariants).toContainEqual(expect.objectContaining({reasoning:{effort:'low'},outputStressSamples:0,
  testedOutputLimit:2048,outputSemanticsEvidence:'same-route-none'}));
});
