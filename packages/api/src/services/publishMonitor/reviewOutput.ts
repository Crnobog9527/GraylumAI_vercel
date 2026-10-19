/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';

const review=z.object({id:z.string().uuid(),periodStart:z.string(),status:z.enum(['claimed','completed','skipped']),
 body:z.string().nullable(),tables:z.unknown(),notice:z.string().nullable()}).passthrough();
/** Existing Runtime results remain authoritative; no second saved copy of private source data. */
export async function readReviews(db:Pick<SupabaseClient,'rpc'>,actor:string){
 const r=await db.rpc('publish_monitor_reviews',{a:actor});
 if(r.error)throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
 return z.array(review).max(52).parse(r.data);
}
/** Download contract for the workspace card. Numeric tables are the stored host result, never parsed from prose. */
export async function exportReview(db:Pick<SupabaseClient,'rpc'>,actor:string,id:string){
 const result=(await readReviews(db,actor)).find(r=>r.id===id&&r.status==='completed'&&r.body!==null);
 if(!result)throw new Error('PUBLISH_MONITOR_REVIEW_NOT_FOUND');
 return {filename:`weekly-review-${result.periodStart.slice(0,10)}.json`,mediaType:'application/json',
  content:JSON.stringify({type:'review',periodStart:result.periodStart,body:result.body,tables:result.tables},null,2)};
}
