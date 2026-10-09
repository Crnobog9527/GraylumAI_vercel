/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
const evidence=z.object({workerStopped:z.literal(true),ioSettled:z.literal(true),
 workerEvidenceHash:z.string().regex(/^[0-9a-f]{64}$/),ioEvidenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 authNeverDispatched:z.boolean()}).strict();
const receipt=z.object({profileId:z.string().uuid(),requestId:z.string().uuid(),token:z.string().uuid(),evidence}).strict();
const rows=z.array(z.object({request_id:z.string().uuid(),executor_token:z.string().uuid().nullable(),
 executor_recovery_evidence:z.unknown().nullable()}).strict()).length(1);
/** Privileged operator tool, never called by cron. Evidence hashes reference independently
 * reviewed invocation termination and original I/O outcomes. They are attestations, not
 * runtime proof; an expired clock or an unknown response is insufficient. */
export async function recoverErasureClaim(client,input){
 const value=receipt.parse(input);
 const read=async()=>{
  const response=await client.from('account_erasure_requests').select('request_id,executor_token,executor_recovery_evidence',{count:'exact'})
   .eq('profile_id',value.profileId).limit(2).abortSignal(AbortSignal.timeout(2000));
  if(response.error||response.count!==1)throw new Error('ERASURE_RECOVERY_UNKNOWN');
  const [row]=rows.parse(response.data);if(row.request_id!==value.requestId)throw new Error('ERASURE_IDENTITY_MISMATCH');return row;
 };
 const matches=row=>row.executor_recovery_evidence?.token===value.token
  && evidence.safeParse(row.executor_recovery_evidence?.evidence).success
  && Object.keys(value.evidence).every(key=>row.executor_recovery_evidence.evidence[key]===value.evidence[key]);
 const before=await read();if(matches(before))return {recovered:true};
 if(before.executor_token!==value.token)throw new Error('ERASURE_EXECUTOR_NOT_CLAIMED');
 const observed=await client.auth.admin.getUserById(value.profileId);
 const authState=!observed.error&&observed.data?.user?.id===value.profileId?'present':
  observed.error?.status===404&&observed.error?.code==='user_not_found'?'absent':'unknown';
 if(authState==='unknown')throw new Error('ERASURE_AUTH_UNKNOWN');
 try{
  const result=await client.rpc('account_erasure_executor_recover',{p_profile_id:value.profileId,p_request_id:value.requestId,
   p_token:value.token,p_evidence:value.evidence,p_auth_state:authState}).abortSignal(AbortSignal.timeout(2000));
  if(result.error||result.data?.recovered!==true)throw new Error('ERASURE_RECOVERY_UNKNOWN');
 }catch{if(!matches(await read()))throw new Error('ERASURE_RECOVERY_UNKNOWN');}
 return {recovered:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==4||process.argv[2]!=='--apply-reviewed-recovery')throw new Error('usage');
  const input=JSON.parse(await readFile(process.argv[3],'utf8'));
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
   {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  await recoverErasureClaim(client,input);process.stdout.write('ERASURE_RECOVERY_RECORDED\n');
 }catch{process.stderr.write('ERASURE_RECOVERY_NOT_CONFIRMED\n');process.exitCode=1;}
}
