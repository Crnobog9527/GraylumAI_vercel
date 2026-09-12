/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
export const preferenceScope=z.object({scope:z.string().regex(/^(user|account:[a-z0-9][a-z0-9._:-]{0,159})$/)}).strict();
export const preferenceChange=preferenceScope.extend({name:z.string().trim().min(1).max(80),value:z.string().trim().min(1).max(1000).optional(),expectedVersion:z.number().int().nonnegative(),confirmed:z.literal(true),requestId:z.string().uuid(),action:z.enum(['confirm','delete'])}).strict();
const preference=z.object({scope:z.string(),name:z.string(),value:z.string().nullable(),active:z.boolean(),version:z.number().int().positive(),source:z.literal('explicit_user_confirmation')});
export const preferenceReference=preferenceScope.extend({name:z.string().min(1).max(80),version:z.number().int().positive()}).strict();
export function confirmedPreferences(user:SupabaseClient,admin:SupabaseClient|null) {
 async function call(action:string,payload:unknown) {
  if(!admin)throw new Error('PREFERENCE_UNAVAILABLE');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PREFERENCE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('PREFERENCE_DENIED');
  const r=await admin.rpc('agent_preference',{p_actor_id:auth.data.user.id,p_action:action,p_payload:payload}).abortSignal(AbortSignal.timeout(10000));
  if(r.error)throw new Error(r.error.message.includes('PREFERENCE_CONFLICT')?'PREFERENCE_CONFLICT':r.error.message.includes('PREFERENCE_DENIED')?'PREFERENCE_DENIED':'PREFERENCE_UNAVAILABLE');
  return r.data;
 }
 return {
  async read(input:z.infer<typeof preferenceScope>) {return preference.array().parse(await call('read',preferenceScope.parse(input)));},
  async change(input:z.infer<typeof preferenceChange>) {const {action,...payload}=preferenceChange.parse(input);return z.object({version:z.number().int().positive()}).parse(await call(action,payload));},
  async resolve(frozen:unknown) {
   const refs=preferenceReference.array().max(40).parse(frozen);
   const scopes=[...new Set(refs.map(ref=>ref.scope))];
   const current=(await Promise.all(scopes.map(scope=>call('read',{scope}).then(value=>preference.array().parse(value))))).flat();
   // Frozen executions retain identities, not a second permanent copy of values.
   // A correction or deletion invalidates the old execution's use of that value.
   return refs.map(ref=>{
    const row=current.find(row=>row.scope===ref.scope&&row.name===ref.name);
    if(!row?.active||row.version!==ref.version||row.value===null)throw new Error('PREFERENCE_CONFLICT');
    return row;
   });
  },
 };
}
