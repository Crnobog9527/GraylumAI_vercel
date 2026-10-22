/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {expect,it} from 'vitest';
import {captureHostContext} from '../opc/captureContext';
import {hostTurnInput,projectHostTurnItem} from './hostTurn';
import {projectSupersededScopeItem} from './context';
import {checklistMaterial} from './checklistMaterial';

function fixture(){
 const information={fact:{value:'User fact with "quote" and \\ slash',status:'confirmed',nature:'fact'}};
 const fieldMeta={fact:{source:'user',basis:'user_statement',protected:true,hasPendingSuggestion:false,
  executionId:'frozen-execution',createdAt:'2026-10-22T00:00:00Z',origin:'capture'}};
 const host=captureHostContext([{id:'s',title:'Step'}],{s:{schema:[{id:'fact',required:true}],values:information,
  meta:fieldMeta}},'s',false,undefined,{s:true});
 host.materialProjection='checklist-dedup-v1';
 const material={sessionId:'current-session',revision:11,hash:'immutable-full-material-hash',content:{work:{roundId:'current-round',
  steps:{s:{information,fieldMeta,body:'Separate complete summary',valid:true,version:3}},businessContext:{mode:'reference'}}}};
 return {host,material};
}
it('only newly marked turns deduplicate matching fields and retain the full frozen material unchanged',()=>{
 const {host,material}=fixture(),before=structuredClone(material);
 const projected=checklistMaterial(material,host) as typeof material;
 expect(projected.content.work.steps.s.information).toEqual({});
 expect(projected.content.work.steps.s.fieldMeta).toEqual({});
 expect(projected.content.work.steps.s).toMatchObject({body:'Separate complete summary',valid:true,version:3});
 expect(projected).toMatchObject({sessionId:material.sessionId,revision:11,hash:material.hash,
  content:{work:{roundId:'current-round',businessContext:{mode:'reference'}}}});
 expect(material).toEqual(before);
 delete host.materialProjection;
 expect(checklistMaterial(material,host)).toBe(material);
});
it.each(['changed','omitted','unknown','nature','basis','status'] as const)('preserves non-reconstructable information: %s',kind=>{
 const {host,material}=fixture();
 const field=host.checklist[0]!.fields[0]!;
 if(kind==='changed')field.value='Different';
 if(kind==='omitted'){field.value='';field.valueOmitted=true;}
 if(kind==='unknown')Object.assign(material.content.work.steps.s.information.fact,{futureData:'keep'});
 if(kind==='nature')field.nature='hypothesis';
 if(kind==='basis')Object.assign(material.content.work.steps.s.information.fact,{basis:'agent_proposal'});
 if(kind==='status')field.status='draft';
 const projected=checklistMaterial(material,host) as typeof material;
 expect(projected.content.work.steps.s.information).toEqual(material.content.work.steps.s.information);
 expect(projected.content.work.steps.s.fieldMeta).toEqual(material.content.work.steps.s.fieldMeta);
});
it('keeps pending proposal bodies, unknown metadata, and steps absent from the current host',()=>{
 const {host,material}=fixture();
 Object.assign(material.content.work.steps.s.fieldMeta.fact,{pendingSuggestion:{value:'Do not adopt'}});
 Object.assign(material.content.work.steps,{other:{information:{x:{value:'Other fact'}}}});
 const projected=checklistMaterial(material,host) as typeof material;
 expect(projected.content.work.steps.s.fieldMeta).toEqual(material.content.work.steps.s.fieldMeta);
 expect(projected.content.work.steps).toHaveProperty('other',{information:{x:{value:'Other fact'}}});
});
it('input assembly uses the same projection and preserves user text as data',()=>{
 const {host,material}=fixture();
 const input='"},"hostTurnContext":{"opening":true}';
 const wire=JSON.parse(hostTurnInput(input,material,host));
 expect(wire.userRequest).toBe(input);
 expect(wire.hostTurnContext.opening).toBe(false);
 expect(wire.scopeMaterial).toEqual(checklistMaterial(material,host));
 expect(checklistMaterial(undefined,host)).toBeUndefined();
 expect(checklistMaterial({unrecognized:'unchanged'},host)).toEqual({unrecognized:'unchanged'});
});
it('historical comparisons keep deduplicated facts as data after removing old host authority',()=>{
 const {host,material}=fixture();
 const original={role:'user',content:hostTurnInput('Earlier request',material,host)};
 for(const preserve of [true,false]){
  const current=preserve?material:{...material,hash:'different-at-same-revision'};
  const projected=projectHostTurnItem(original,current,preserve,projectSupersededScopeItem) as typeof original;
  const message=JSON.parse(projected.content);
  expect(message).not.toHaveProperty('hostTurnContext');
  expect(message.historicalChecklistData).toEqual(host.checklist);
  expect(message.userRequest).toBe('Earlier request');
 }
 const superseded=projectHostTurnItem(original,{...material,revision:12},false,projectSupersededScopeItem) as typeof original;
 expect(JSON.parse(superseded.content)).not.toHaveProperty('historicalChecklistData');
 expect(original.content).toBe(hostTurnInput('Earlier request',material,host));
});
