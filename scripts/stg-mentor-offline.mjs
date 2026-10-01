/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Existing OPC integration runner + probe overlay. There is deliberately no live option.
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, unlinkSync} from 'node:fs';
import {resolve, join} from 'node:path';
const args=process.argv.slice(2);
if(args.length!==4)throw new Error('Usage: node scripts/stg-mentor-offline.mjs DETACHED_FROZEN_ROOT SKILL_DIR SCENARIOS_JSON OUTPUT_DIR');
const [root,skill,scenariosPath,output]=args.map(p=>resolve(p));
const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
const frozen='f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd';
if(git('rev-parse','HEAD')!==frozen||git('branch','--show-current'))throw new Error('Exact detached frozen checkout required');
if(git('status','--porcelain'))throw new Error('Clean detached checkout required');
const require=createRequire(join(root,'packages/api/package.json'));
const {parse}=require('yaml');
const manifest=parse(readFileSync(join(skill,'workflow.yaml'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const source=readFileSync(scenariosPath);
if(hash(source)!=='0be012a845999a8d6c345a74df7a66e9cb61e3242dac4db98880ef8ebcd2564a')throw new Error('Scenario hash mismatch');
const scenarios=JSON.parse(source).scenarios;
const files=[];
function walk(relative='') {
  for(const entry of readdirSync(join(skill,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=relative?relative+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())throw new Error('Skill symlink refused');
    if(entry.isDirectory())walk(path);
    else if(/\.(md|yaml)$/.test(path))files.push({path,base64:readFileSync(join(skill,path)).toString('base64')});
  }
}
walk();
const moduleSkill={moduleId:randomUUID(),skillId:randomUUID(),revisionId:randomUUID(),requestId:randomUUID(),
  expectedVersion:0,expectedUpdatedAt:null,kind:manifest.kind,directoryName:'social-media-commercial-strategist',files,
  steps:manifest.steps,planResources:manifest.planResources,resourcePlanReviewed:true,
  module:{title:'Offline mentor preparation',description:null,full_description:null,model_id:randomUUID(),platform:'all',
    category:'business',icon:'test',image_url:null,badge_type:null,badge_text:null,credits_display:null,sort_order:0,
    active:true,is_featured:false,features:null,examples:null,preparation_questions:null}};
mkdirSync(output,{recursive:true,mode:0o700});
const inputPath=join(output,'private-input.json');
writeFileSync(inputPath,JSON.stringify({moduleSkill,scenarios,scenariosSourceHash:hash(source),
  scenariosCanonicalHash:hash(JSON.stringify(scenarios))}),{mode:0o600});
const overlay='packages/api/src/scripts/ac0Probe/mentorPreparation.mjs';
const entry='packages/api/src/services/opc/opc.integration.ts';
const original=readFileSync(join(root,entry));
copyFileSync(new URL('../'+overlay,import.meta.url),join(root,overlay));
writeFileSync(join(root,entry),Buffer.concat([original,Buffer.from("\nimport '../../scripts/ac0Probe/mentorPreparation.mjs';\n")]));
git('add','--',overlay);
try {
  const result=spawnSync(process.execPath,['packages/db/tests/v3/run-workbench.mjs','--opc-only','--with-staging-schema',
    '--case-pattern=STG_MENTOR'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,
      V3_REAL_SKILL_INPUT:inputPath,V3_WORKBENCH_OUTPUT:output},stdio:'inherit'});
  if(result.status!==0)throw new Error('Offline runner failed; inspect local evidence');
} finally {
  writeFileSync(join(root,entry),original);
  git('reset','--',overlay);
  unlinkSync(join(root,overlay));
  // Retain private evidence; restore the disposable checkout to its original bytes.
  if(git('diff','--name-only',frozen,'--','packages/api/src/services','packages/api/src/shared','packages/db','pnpm-lock.yaml'))
    throw new Error('Frozen product drift');
}
