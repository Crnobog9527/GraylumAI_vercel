/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {TRPCError} from '@trpc/server';
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';

/**
 * PUBLISH-MONITOR block D (Owner 2026-11-03): the user edits a brand's content pillars as a simple setting (add, rename, delete,
 * reorder). The database keeps keys stable and sends a deleted pillar's posts back to "未分类"; the next review and title tagging
 * read the saved list.
 */
export const PILLARS_MAX=6;
const pillar=z.object({key:z.string().regex(/^[a-z0-9_]{1,16}$/),name:z.string(),definition:z.string()}).passthrough();
const brand=z.object({businessId:z.string().uuid(),businessName:z.string().nullable(),pillars:z.array(pillar).max(PILLARS_MAX),
 source:z.enum(['extracted','user']).nullable()});
export const pillarsSaveInput=z.object({businessId:z.string().uuid(),
 pillars:z.array(z.object({key:z.string().regex(/^[a-z0-9_]{1,16}$/).nullable(),name:z.string().trim().min(1)
  // Characters, as the database counts them (an emoji is one), not UTF-16 units.
  .refine(n=>Array.from(n).length<=40)}).strict())
  .max(PILLARS_MAX),
 /** The list the page read: a save built on an out-of-date list is refused (PILLARS_CHANGED) instead of undoing another window. */
 base:z.array(z.object({key:z.string().regex(/^[a-z0-9_]{1,16}$/),name:z.string().max(200)}).strict()).max(PILLARS_MAX)}).strict();
/** Codes the page can say in words; anything else is the generic failure. */
const USER_ERRORS=['PUBLISH_MONITOR_PILLAR_NAME_INVALID','PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE','PUBLISH_MONITOR_PILLAR_KEY_INVALID',
 'PUBLISH_MONITOR_PILLARS_CHANGED',
 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND','PUBLISH_MONITOR_ACCOUNT_CLOSED','PUBLISH_MONITOR_INPUT_INVALID'] as const;
type Rpc=Pick<SupabaseClient,'rpc'>;
/** The comparison title tagging uses (coach/autotag.ts): names equal under it are one name. */
export const pillarNameKey=(name:string)=>name.normalize('NFKC').toLowerCase().replace(/\s+/g,'');

function fail(message:string|undefined):never{
 const code=USER_ERRORS.find(c=>message?.includes(c));
 if(code)throw new TRPCError({code:code==='PUBLISH_MONITOR_ACCOUNT_CLOSED'?'FORBIDDEN':'BAD_REQUEST',message:code});
 throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
}

export async function readPillars(db:Rpc,actor:string){
 const r=await db.rpc('publish_monitor_coach_pillars',{a:actor});
 if(r.error)fail(r.error.message);
 return z.array(brand).parse(r.data);
}

export async function savePillars(db:Rpc,actor:string,input:z.infer<typeof pillarsSaveInput>){
 const names=input.pillars.map(p=>pillarNameKey(p.name));
 if(new Set(names).size!==names.length)throw new TRPCError({code:'BAD_REQUEST',message:'PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE'});
 const r=await db.rpc('publish_monitor_coach_pillars_save',{a:actor,p_business_id:input.businessId,p_pillars:input.pillars,p_base:input.base});
 if(r.error)fail(r.error.message);
 return z.object({businessId:z.string().uuid(),pillars:z.array(pillar),source:z.literal('user'),removed:z.array(z.string())}).parse(r.data);
}
