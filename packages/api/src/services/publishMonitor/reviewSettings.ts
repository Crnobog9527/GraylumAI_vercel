/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
export const REVIEW_SWITCH='publish_monitor_review_enabled';
export const REVIEW_MODEL='publish_monitor_review_model_id';
export const REVIEW_CAP='publish_monitor_review_max_usd';
export async function readReviewSettings(db:Pick<SupabaseClient,'from'>){
 const r=await db.from('system_settings').select('key,value').in('key',[REVIEW_SWITCH,REVIEW_MODEL,REVIEW_CAP,'primary_model_id']);
 if(r.error)throw new Error('PUBLISH_MONITOR_REVIEW_SETTINGS_UNAVAILABLE');
 const value=(key:string)=>r.data?.find(row=>row.key===key)?.value;
 const model=value(REVIEW_MODEL)||value('primary_model_id');
 const modelId=z.string().uuid().safeParse(model);
 const cap=z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/).safeParse(String(value(REVIEW_CAP)??'0'));
 return {enabled:value(REVIEW_SWITCH)===true,modelId:modelId.success?modelId.data:null,
  maxCostUsd:cap.success?cap.data:'0'};
}
