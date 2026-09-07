/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect} from 'vitest';
import {validateWorkflow} from '../artifacts/workflow';
import {commandSchema} from '../artifacts/store';
import {makePackage,makeWorkflow} from './fixtures/artifacts';
describe('artifact host workflow admission',()=>{
 it.each([3,6,8])('validates %i steps with one definition and fixed identity',n=>{
  const {descriptor}=makePackage();const f=makeWorkflow(n);expect(validateWorkflow(f,descriptor)).toEqual(f);
 });
 it.each(['cycle','missingDependency','duplicate','resource','capability','report','unknown','capacity','bounds'])('rejects %s before any external execution',mode=>{
  const f=makeWorkflow(3),{descriptor}=makePackage();
  if(mode==='cycle')f.steps[0].dependsOn=['step-2'];
  if(mode==='missingDependency')f.steps[0].dependsOn=['missing'];
  if(mode==='duplicate')f.steps[1].id=f.steps[0].id;
  if(mode==='resource')f.steps[0].resources=['private-missing.md'];
  if(mode==='capability')(f.steps[0].requiredCapabilities as string[])=["shell.execute"];
  if(mode==='report')f.report.sections.pop();
  if(mode==='unknown')Object.assign(f,{execute:'arbitrary'});
  if(mode==='capacity')f.steps=Array.from({length:33},(_,i)=>({...f.steps[0],id:`n-${i}`}));
  if(mode==='bounds')f.steps[0].minLength=20001;
  expect(()=>validateWorkflow(f,descriptor)).toThrow('ARTIFACT_INVALID_WORKFLOW');
 });
 it('rejects client actor overrides and arbitrary payloads',()=>{
  expect(commandSchema.safeParse({action:'read',projectId:crypto.randomUUID(),roundId:crypto.randomUUID(),actorId:crypto.randomUUID()}).success).toBe(false);
 });
});
