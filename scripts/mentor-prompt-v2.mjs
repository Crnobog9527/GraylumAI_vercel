/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// #561 single-turn harness, frozen to the caller-specified clean candidate.
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertOutsideRepository} from '../packages/api/src/scripts/ac0Probe/paths.ts';
import {liveBridge} from './stg-mentor-live.mjs';
const [head,inputArg,outArg,...liveArgs]=process.argv.slice(2);
if(!/^[a-f0-9]{40}$/.test(head??'')||!inputArg||!outArg||![0,3].includes(liveArgs.length))
  throw new Error('Usage: mentor-prompt-v2.mjs HEAD PRIVATE_INPUT OUTPUT [--live EVIDENCE SHA256]');
const root=resolve(new URL('..',import.meta.url).pathname);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git('rev-parse','HEAD')!==head||git('status','--porcelain'))throw new Error('CLEAN_FROZEN_HEAD_REQUIRED');
const inputPath=resolve(inputArg),output=resolve(outArg);
assertOutsideRepository(inputPath);assertOutsideRepository(output);
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const raw=readFileSync(inputPath);
if(hash(raw)!=='406d521f92b5da5f1356ae7bc9a6f05175a47ffd12752ff39cc540193e3780c6')
  throw new Error('ORIGINAL_561_INPUT_REQUIRED');
// Exclusive output directory prevents a retry from overwriting earlier paid evidence.
mkdirSync(output,{mode:0o700});
const input=JSON.parse(raw);input.frozenHead=head;
const temporary=join(root,'packages/api/src/scripts/ac0Probe/mentorPreparation.test.ts');
const privateInput=join(output,'private-input.json');
let bridge;
try {
  if(liveArgs.length){
    const [flag,evidencePath,evidenceHash]=liveArgs;
    if(flag!=='--live'||!/^[a-f0-9]{64}$/.test(evidenceHash))throw new Error('LIVE_EVIDENCE_REQUIRED');
    // The interrupted old-head batch settled $0.0287535; both batches share the $6 limit.
    bridge=await liveBridge({maxUsd:5.9712465,evidencePath:resolve(evidencePath),evidenceHash,frozenHead:head,output});
    input.live={url:bridge.url,secret:bridge.secret};
  }
  writeFileSync(privateInput,JSON.stringify(input),{mode:0o600});
  writeFileSync(temporary,"import './mentorPreparation.mjs';\n",{flag:'wx'});
  const child=spawn('pnpm',['exec','vitest','run',temporary],{cwd:join(root,'packages/api'),
    env:{PATH:process.env.PATH,HOME:process.env.HOME,V3_REAL_SKILL_INPUT:privateInput,V3_WORKBENCH_OUTPUT:output},
    stdio:'inherit'});
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(status!==0)throw new Error('MENTOR_RUN_STOPPED_INSPECT_EVIDENCE_DO_NOT_RETRY');
  if(bridge)console.log('80 samples complete; independent blind review pending. No further calls authorized.');
} finally {
  await bridge?.close();
  delete input.live;writeFileSync(privateInput,JSON.stringify(input),{mode:0o600});
  try{unlinkSync(temporary);}catch{}
  if(git('diff','--name-only',head))throw new Error('FROZEN_PRODUCT_DRIFT');
}
