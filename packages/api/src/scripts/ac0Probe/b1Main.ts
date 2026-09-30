/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Fixed, single-use B1 entry. Dry-run by default; not imported by application code.
import {registerHooks} from 'node:module';
import {existsSync,mkdirSync,statSync,writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Node's strip-types runner needs extensions for the unchanged runtime graph.
// This resolution hook applies only to relative source files inside packages/api/src.
const sourceRoot=new URL('../../',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
  if(context.parentURL&&specifier.startsWith('.')){
    const candidate=new URL(specifier,context.parentURL);
    if(candidate.href.startsWith(sourceRoot)&&!candidate.pathname.match(/\.[a-z]+$/)){
      for(const suffix of ['.ts','/index.ts']){
        const mapped=candidate.href+suffix;
        if(existsSync(fileURLToPath(mapped)))return next(mapped,context);
      }
    }
  }
  return next(specifier,context);
}});
const {runB1Pair}=await import('./b1Protocol.ts');
const {loadSkill,loadScenarios}=await import('./skill.ts');
const {createBudget,memoryLedger,nanoToUsd,usdToNano,HARD_MAX_CALLS,HARD_MAX_USD}=await import('./budget.ts');
const {fileLedger,acquireLedgerLock}=await import('./ledger.ts');
const {accountHome,assertOutsideRepository,realPath}=await import('./paths.ts');
const {sseResponse,textDeltas,toolDeltas}=await import('./dryRun.ts');
const {values}=parseArgs({strict:true,options:{live:{type:'boolean'},confirm:{type:'string'},
 'skill-dir':{type:'string'},scenarios:{type:'string'},'out-dir':{type:'string'}}});
if(!values['skill-dir']||!values.scenarios||!values['out-dir'])throw new Error('B1_PATHS_REQUIRED');
for(const path of [values['skill-dir'],values.scenarios,values['out-dir']])assertOutsideRepository(path);
const live=values.live===true;
const skill=loadSkill(values['skill-dir']);
const {scenarios,digest}=loadScenarios(values.scenarios,skill,true);
if(skill.digest!=='1d0f551e28232780'||digest!=='e585aef56b0c60a8')
 throw new Error('B1_PRIVATE_INPUT_IDENTITY_CHANGED');
const ids=['A01_platforms_main','B01_time_ranges','B03_platforms_list'];
const selected=ids.map(id=>{const scenario=scenarios.find((s:{id:string})=>s.id===id);
 if(!scenario)throw new Error('B1_SCENARIO_MISSING');return scenario;});
const ledgerPath=realPath(join(accountHome(),'.graylum/ac0/ledger.json'));
const out=realPath(values['out-dir']);mkdirSync(out,{recursive:true,mode:0o700});
if(statSync(out).mode&0o077)throw new Error('B1_OUTPUT_NOT_PRIVATE');
let release:(()=>void)|undefined;
let key='offline-only';
try{
 if(live){
  if(values.confirm!=='B1-6-calls-USD-1.50')throw new Error('B1_CONFIRM_REQUIRED');
  release=acquireLedgerLock(ledgerPath);
  key=process.env.AC0_OPENROUTER_API_KEY?.trim()??'';
  if(!key||/\s/.test(key))throw new Error('B1_CAPPED_TEST_KEY_REQUIRED');
 }
 const ledger=live?fileLedger(ledgerPath):memoryLedger();
 const before=ledger.read();
 if(live&&(before.calls!==729||before.calls+6>HARD_MAX_CALLS||
  before.nanoUsd+usdToNano(1.5)>usdToNano(HARD_MAX_USD)))throw new Error('B1_LEDGER_BASELINE_CHANGED');
 const budget=createBudget({maxCalls:6,maxUsd:1.5,ledger});
 const pairs=[];
 const write=(name:string,value:unknown)=>{
  const text=JSON.stringify(value,null,2).split(key).join('[REDACTED]');
  writeFileSync(join(out,name),text+'\n',{mode:0o600});
 };
 write('plan.json',{mode:live?'live':'dry-run',ids,model:'anthropic/claude-sonnet-5.5',route:'anthropic',
  reasoning:'low',maxTokens:4096,maxCalls:6,maxUsd:1.5,skillDigest:skill.digest,before,
  approval:'https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5911114620'});
 for(const scenario of selected){
  let simulatedCalls=0;
  const transport:typeof fetch=live?fetch:async(_url,init)=>{
   const model=JSON.parse(String(init?.body)).model;
   const usage={prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.0003};
   return ++simulatedCalls===1?sseResponse(model,[...textDeltas('Offline preparation.'),
    ...toolDeltas('ask_question',{question:'Synthetic choice?',options:['Option A','Option B'],recommended:null})],
    {finish:'tool_calls',usage}):sseResponse(model,textDeltas('Offline continuation.'),{usage});
  };
  const pair=await runB1Pair({skill,scenario,budget,transport,credential:async()=>key,
   save:value=>write(scenario.id+'.json',value)});
  pairs.push(pair);
  const summary={mode:live?'live':'dry-run',verdict:pairs.some(p=>p.verdict==='FAIL')?'FAIL':
   pairs.length===3&&pairs.every(p=>p.verdict==='PASS')?'PASS':pairs.some(p=>p.verdict==='UNKNOWN')?'UNKNOWN':'INCOMPLETE',
   groups:pairs.map(p=>({id:p.scenarioId,verdict:p.verdict,turns:p.turns.map(t=>({turn:t.turn,state:t.state,
    httpStatus:t.httpStatus,normalization:t.normalization,requestBytes:t.requestBytes,bookedUsd:t.bookedUsd}))})),
   calls:budget.run.calls,bookedUsd:nanoToUsd(budget.run.nanoUsd),ledgerAfter:ledger.read()};
  write('summary.json',summary);
  console.log(JSON.stringify(summary));
  if(budget.stopped||pair.verdict==='UNKNOWN')break;
 }
}finally{release?.();}
