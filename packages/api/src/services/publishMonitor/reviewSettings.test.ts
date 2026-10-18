/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {readReviewSettings} from './reviewSettings';
const fallback='10000000-0000-4000-8000-000000000001',dedicated='10000000-0000-4000-8000-000000000002';
const db=(rows:Record<string,unknown>)=>({from:()=>({select:()=>({in:async()=>({
 data:Object.entries(rows).map(([key,value])=>({key,value})),error:null})})})}) as never;
it('defaults off with zero budget; a missing dedicated model falls back to the conversation model',async()=>{
 expect(await readReviewSettings(db({primary_model_id:fallback}))).toEqual({enabled:false,modelId:fallback,maxCostUsd:'0'});
 expect(await readReviewSettings(db({primary_model_id:fallback,publish_monitor_review_model_id:dedicated,
  publish_monitor_review_max_usd:'0.1',publish_monitor_review_enabled:true})))
  .toEqual({enabled:true,modelId:dedicated,maxCostUsd:'0.1'});
});
it('invalid cost/model settings cannot silently enable a charged review',async()=>{
 expect(await readReviewSettings(db({primary_model_id:'bad',publish_monitor_review_max_usd:'-1'})))
  .toEqual({enabled:false,modelId:null,maxCostUsd:'0'});
});
