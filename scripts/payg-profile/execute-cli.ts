/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {executePlan,verifiedPlan,verifyCatalog,type Event} from './executor';

export async function main(args:string[]){
 const [mode,pricesPath,manifestPath,approvedHash,authorization,...rest]=args;
 if(mode!=='execute-approved'||!pricesPath||!manifestPath||!approvedHash||rest.length
  ||authorization!=='owner-approved-test-balance-only')throw new Error('EXECUTION_AUTHORIZATION_REQUIRED');
 const prices=JSON.parse(await readFile(pricesPath,'utf8'));
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 const plan=verifiedPlan(prices,manifest,approvedHash);
 const catalog=JSON.parse(await readFile(resolve('scripts/payg-profile/catalog-2026-10-05.json'),'utf8'));
 // Stable per-manifest location prevents a restart or changed output path from sending twice.
 const directory=join(homedir(),'.local','state','graylum','payg-profile',plan.manifest.manifestHash);
 await mkdir(directory,{recursive:true,mode:0o700});
 const lock=await open(join(directory,'attempted.lock'),'wx',0o600);
 await lock.writeFile('One-shot batch. Never remove to resume automatically.\n');await lock.sync();await lock.close();
 const events:Event[]=[];
 const log=await open(join(directory,'events.jsonl'),'ax',0o600);
 const parent=await open(directory,'r');await parent.sync();await parent.close();
 const journal={events,append:async(event:Event)=>{await log.writeFile(JSON.stringify(event)+'\n');await log.sync();},
  saveObservation:async(id:string,source:string,observation:unknown)=>{
   const name=createHash('sha256').update(id).digest('hex');
   const file=await open(join(directory,`${name}-${source}.private.json`),'wx',0o600);
   try{await file.writeFile(JSON.stringify(observation));await file.sync();}finally{await file.close();}
  }};
 try{
  const result=await executePlan({prices,manifest,approvedHash,journal,
   credential:async()=>{
    // Supplied explicitly for the approved test balance. Never load project .env or fall back to another key.
    const key=process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
    if(!key)throw new Error('APPROVED_TEST_CREDENTIAL_MISSING');return key;
   },preflight:model=>verifyCatalog(prices,catalog,model)});
  await writeFile(join(directory,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({manifestHash:approvedHash,attempts:events.filter(e=>e.type==='attempt').length,
   halted:events.some(e=>e.type==='halt'),directory}));
 }finally{await log.close();}
}
