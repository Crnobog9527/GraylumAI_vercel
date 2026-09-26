/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import type {RuntimeBudget} from './budget';
import {StagingAccessError} from './stagingErrors';
/** Capture only the credential, never the authorization verdict. Every operation
 * still verifies the original user with Auth. Explicit JWT verification avoids
 * a new implicit session refresh/backoff during the persistence-only margin. */
export function runtimeActor(auth:Pick<SupabaseClient['auth'],'getSession'|'getUser'>,userId:string,budget:RuntimeBudget,authorization?:string|null){
 const coversPersistence=(jwt:string)=>{
  try{const exp=JSON.parse(Buffer.from(jwt.split('.')[1]??'','base64url').toString()).exp;return Number.isSafeInteger(exp)&&exp*1000-Date.now()>budget.remainingPersistence();}
  catch{return false;}
 };
 let token:Promise<string>|undefined;
 return async()=>{
  if(!token){
   // The SDK can retry session refresh for 30s. Start it before that margin.
   budget.assertCanPersist(30_000);
   token=(async()=>{
    const session=await auth.getSession();
    const jwt=session.data.session?.access_token??authorization?.match(/^Bearer (.+)$/i)?.[1];
    if(!jwt)throw new Error('RUNTIME_DENIED');
    // SDK refreshes only within 90s of expiry. A valid 100–200s token may
    // expire mid-request; refuse before claim and let the client refresh.
    // Decoding exp grants no authority: getUser(jwt) still verifies every use.
    if(!coversPersistence(jwt))throw new StagingAccessError('RUNTIME_STAGING_AUTH_REFRESH_REQUIRED');
    return jwt;
   })();
  }
  const jwt=await token;
  budget.assertCanPersist();
  const result=await auth.getUser(jwt);
  budget.assertCanPersist();
  if(result.error||result.data.user?.id!==userId)throw new Error('RUNTIME_DENIED');
  return userId;
 };
}
