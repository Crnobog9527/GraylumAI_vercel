/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {captureHostContext} from '../opc/captureContext';
import {researchCapacity} from './researchCapacity';
import {researchToolBytes,sentHostBytes} from './researchAdmission';
import {POSITIONING_RESEARCH_TOOLS} from '../research/tools/schemas';
import {runtimeScopeInput} from './context';
import {groundedCardToolBytes} from './groundedCard';
import {REPLY_LANGUAGE_INSTRUCTIONS} from './primaryInstructions';
import {RESEARCH_RESULT_RESERVE_BYTES} from './researchTurn';
import {withResearchContext,shortfallContext} from './researchHostContext';
import {RESEARCH_CARDS_NOTE} from './hostTurn';

const path=process.env.RESEARCH_CAPACITY_SAVED_STATE;
it.skipIf(!path)('replays saved current-round admission offline and emits only numeric accounting',()=>{
 const saved=JSON.parse(readFileSync(path!,'utf8'));
 const context=saved.execution.payload;
 const material={sessionId:saved.material.session_id,revision:saved.material.revision,
  hash:saved.material.content_hash,content:saved.material.content};
 const oldHost=context.hostTurnContext;
 const information=Object.fromEntries(oldHost.checklist.map((step:{id:string;fields:Array<{id:string;title:string;required:boolean;role:string}>})=>[
  step.id,{schema:step.fields.map(field=>({id:field.id,title:field.title,required:field.required,elicitation:field.role})),
   values:material.content.work.steps[step.id].information,meta:material.content.work.steps[step.id].fieldMeta}]));
 const host=captureHostContext(oldHost.checklist,information,oldHost.stepId,false,undefined,
  Object.fromEntries(Object.entries(material.content.work.steps).map(([id,step])=>[id,Boolean((step as {valid:boolean}).valid)])));
 if(process.env.RESEARCH_CAPACITY_PROJECT)host.materialProjection='checklist-dedup-v1';
 const researchHost=withResearchContext(host,{note:RESEARCH_CARDS_NOTE,cards:[],
  benchmarks:{required:3,qualified:0,rows:[]},shortfall:shortfallContext({rounds:0,qualified:0,card:null})});
 const result=researchCapacity({instructions:context.instructions+REPLY_LANGUAGE_INSTRUCTIONS,
  currentInput:runtimeScopeInput(context.input,material,host),inputBudgetBytes:112000,
  existingToolsBytes:groundedCardToolBytes()+150,researchToolsBytes:researchToolBytes(POSITIONING_RESEARCH_TOOLS,true),
  researchHostDeltaBytes:sentHostBytes(researchHost)-sentHostBytes(host),resultReserveBytes:RESEARCH_RESULT_RESERVE_BYTES});
 console.info('RESEARCH_CAPACITY_REPLAY',JSON.stringify(result));
 if(process.env.RESEARCH_CAPACITY_OUTPUT)writeFileSync(process.env.RESEARCH_CAPACITY_OUTPUT,JSON.stringify(result,null,2));
 if(process.env.RESEARCH_CAPACITY_PROJECT)expect(result.deficitBytes).toBe(0);
 else expect(result.deficitBytes).toBeGreaterThan(0);
});
