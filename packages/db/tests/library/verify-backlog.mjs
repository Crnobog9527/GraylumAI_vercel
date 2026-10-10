/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Read-only acceptance monitor. Total control creates approved synthetic backlog/failure/late-upload
// scenarios first; this script never creates accounts, signs uploads or enables flags.
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';
const args=process.argv.slice(2);
if(!args.includes('--confirm-staging')) throw new Error('Requires --confirm-staging and an explicitly approved staging target');
const url=process.env.LIBRARY_TEST_SUPABASE_URL;
const key=process.env.LIBRARY_TEST_SERVICE_ROLE_KEY;
const actor=process.env.LIBRARY_TEST_ACTOR;
const output=args[args.indexOf('--out')+1];
if(!url || !key || !actor || !args.includes('--out') || !output) throw new Error('Missing explicit test target, actor or --out');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},
 global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}});
const start=Date.now();
const samples=[];
while(Date.now()-start<24*60*60*1000) {
 const backlog=await client.rpc('library_cleanup_backlog',{a:actor});
 if(backlog.error) throw new Error('Backlog read failed; do not interpret as empty');
 const run=await client.from('scheduled_job_runs').select('started_at,finished_at,status,summary')
  .eq('job_key','library_cleanup').order('started_at',{ascending:false}).limit(1).maybeSingle();
 if(run.error || !run.data) throw new Error('No cleanup run evidence');
 samples.push({elapsedMs:Date.now()-start,...backlog.data,runStatus:run.data.status,
  startedAt:run.data.started_at,finishedAt:run.data.finished_at});
 // Evidence contains only counters/times, no profiles, names, URLs, keys or storage cursors.
 await writeFile(output,JSON.stringify({complete:backlog.data.pending===0,samples},null,2)+'\n');
 if(backlog.data.overdue>0) throw new Error('FAIL: deletion older than 24 hours');
 if(backlog.data.pending===0) {
  if(samples.length===1) throw new Error('NOT_RUN: no backlog observed; populate approved test scenarios first');
  console.log('PASS: observed test backlog drained; retain scenario setup and failure-injection evidence separately');
  process.exit(0);
 }
 await new Promise(r=>setTimeout(r,60000));
}
throw new Error('FAIL: backlog not drained within observation window');
