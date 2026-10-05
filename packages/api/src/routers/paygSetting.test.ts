/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {settingsRouter} from './settings';
it.each([false,true])('PAYG settings validate single/bulk writes and accept emergency off (bulk=%s)',async bulk=>{
 const profile={id:'test-admin',role:'admin',status:'active',nickname:'Test'};
 const upsert=vi.fn();
 const client={from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:profile,error:null}),upsert})};
 const caller=settingsRouter.createCaller({headers:new Headers(),user:{id:profile.id,app_metadata:{provider:'email'},
  user_metadata:{email_verified:true}},isEmailVerified:true,authProvider:'email',hasSupabaseAdminPrivileges:true,
  supabase:client,supabasePublic:{},supabaseAdmin:{from:()=>({select(){return this;},eq(){return this;},
   single:async()=>({data:null,error:{code:'42501'}})})}} as any);
 const write=(value:unknown)=>bulk?caller.updateSystemSettingsBulk([{key:'runtime_payg_staging',value}]):
  caller.updateSystemSettings({key:'runtime_payg_staging',value});
 for(const value of ['{"enabled":false}','false',{enabled:'false'},{enabled:true},null])
  await expect(write(value)).rejects.toMatchObject({code:'BAD_REQUEST'});
 // Valid off gets past schema to the independent writer-permission check.
 await expect(write({enabled:false})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
 expect(upsert).not.toHaveBeenCalled();
});
