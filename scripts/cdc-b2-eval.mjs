/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {hash,profiles,EXPIRES} from './cdc-b2-eval/policy.ts';
import {thirdRound,verifyPriorRounds} from './cdc-b2-eval/thirdRound.ts';
import {bridge} from './cdc-b2-eval/bridge.ts';
import {assertOutsideRepository} from '../packages/api/src/scripts/ac0Probe/paths.ts';
const [mode,inputArg,approvalId]=process.argv.slice(2);
if(!['--freeze','--execute'].includes(mode)||!inputArg||mode==='--freeze'&&approvalId)throw new Error('CDC_USAGE');
const root=resolve(import.meta.dirname,'..'),inputPath=resolve(inputArg);assertOutsideRepository(inputPath);
const inputBytes=readFileSync(inputPath),plan=JSON.parse(inputBytes);assertOutsideRepository(plan.output);
verifyPriorRounds(plan);
if(plan.groups.length!==50||plan.groups.flatMap(g=>g.turns).length!==70)throw new Error('CDC_ROSTER');
const slots=plan.groups.flatMap(g=>g.turns.flatMap(t=>[{slot:t.slot,role:'mentor'},...(t.organize?[{slot:t.slot,role:'organizer'}]:[])]));
if(slots.length!==100||new Set(slots.map(s=>s.slot+':'+s.role)).size!==100)throw new Error('CDC_ROSTER');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sourceFiles=git('ls-files').split('\n').filter(p=>p.startsWith('packages/')||p.startsWith('scripts/')||
 p.startsWith('shared/')||['package.json','pnpm-lock.yaml'].includes(p));
const sourceHash=hash(sourceFiles.map(p=>p+':'+hash(readFileSync(join(root,p)))).join('\n'));
let live;
try{
 if(mode==='--execute'){
  if(!/^\d+$/.test(approvalId??''))throw new Error('CDC_APPROVAL_REQUIRED');
  if(Date.now()>=Date.parse(EXPIRES))throw new Error('CDC_WINDOW_EXPIRED');
  const manifest=JSON.parse(readFileSync(plan.output+'/manifest.json','utf8'));
  if(manifest.inputHash!==hash(inputBytes)||manifest.sourceHash!==sourceHash||git('status','--porcelain'))throw new Error('CDC_FREEZE_CHANGED');
  const comment=JSON.parse(execFileSync('gh',['api',`repos/Crnobog9527/GraylumAI_vercel/issues/comments/${approvalId}`],{encoding:'utf8'}));
  const configComment=JSON.parse(execFileSync('gh',['api','repos/Crnobog9527/GraylumAI_vercel/issues/comments/6002099383'],{encoding:'utf8'}));
  if(comment.issue_url!=='https://api.github.com/repos/Crnobog9527/GraylumAI_vercel/issues/675'||
   comment.user.login!==configComment.user.login||
   !comment.body.split(/\r?\n/).some(line=>line.trim()==='PASS/授权 '+hash(JSON.stringify(manifest))))throw new Error('CDC_APPROVAL_BINDING');
  if(!process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY)throw new Error('CDC_KEY_MISSING');
  const locks=join(homedir(),'.graylum/cdc-b2-authorizations');mkdirSync(locks,{recursive:true,mode:0o700});
  writeFileSync(join(locks,'round-3.lock'),hash(JSON.stringify(manifest)),{flag:'wx',mode:0o600});
  writeFileSync(join(locks,approvalId+'.lock'),manifest.inputHash,{flag:'wx',mode:0o600});
  plan.output+='/live';mkdirSync(plan.output,{mode:0o700});
  live=await bridge(plan.output,slots,process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY);plan.bridge={url:live.url,secret:live.secret};
 }else{mkdirSync(plan.output,{recursive:false,mode:0o700});}
 const runInput=join(plan.output,'run-input.json');writeFileSync(runInput,JSON.stringify(plan),{flag:'wx',mode:0o600});
 const log=join(plan.output,'local-run.log');const {openSync,closeSync}=await import('node:fs');const fd=openSync(log,'wx',0o600);
 const child=spawn(process.execPath,['packages/db/tests/v3/run-workbench.mjs','--runtime-only','--with-staging-schema',
  '--without-app','--schema-from-files','--cdc-b2-eval'],{cwd:root,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,V3_REAL_SKILL_INPUT:runInput},stdio:['ignore',fd,fd]});
 const code=await new Promise(resolve=>child.once('exit',resolve));closeSync(fd);
 delete plan.bridge;writeFileSync(runInput,JSON.stringify(plan),{mode:0o600});
 if(code!==0)throw new Error('CDC_LOCAL_RUN_FAILED_INSPECT_PRIVATE_LOG');
 const summary=JSON.parse(readFileSync(plan.output+'/summary.json','utf8'));
 const totals=Object.fromEntries(Object.keys(profiles).map(role=>[role,{calls:summary.rows.filter(r=>r.role===role).length,
  reserveUsd:summary.rows.filter(r=>r.role===role).reduce((sum,r)=>sum+r.reserveNano,0)/1e9}]));
 const manifest={version:3,thirdRound,sourceHash,inputHash:hash(inputBytes),head:git('rev-parse','HEAD'),profiles,
  privateHash:summary.privateHash,totals,totalReserveUsd:summary.rows.reduce((sum,r)=>sum+r.reserveNano,0)/1e9,
  rows:summary.rows,actualDispatches:mode==='--freeze'?0:100};
 writeFileSync(plan.output+'/manifest.json',JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
 chmodSync(plan.output,0o700);console.log(JSON.stringify({manifestHash:hash(JSON.stringify(manifest)),totals,totalReserveUsd:manifest.totalReserveUsd}));
}finally{await live?.close();}
