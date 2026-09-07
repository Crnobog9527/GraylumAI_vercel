/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {validateDescriptor, type PackageDescriptor} from '../skills/loader';
const id=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const label=z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
export const workflowSchema=z.object({
 id, version:z.number().int().min(1).max(1000000), kind:z.enum(['social','document']),
 steps:z.array(z.object({id,title:label,dependsOn:z.array(id).max(32),resources:z.array(z.string()).min(1).max(64),
  minLength:z.number().int().min(1).max(20000),maxLength:z.number().int().min(1).max(20000),
  requiresEvidence:z.boolean(),requiredCapabilities:z.array(z.enum(['documents.read','research.evidence'])).max(2)}).strict()).min(1).max(32),
 report:z.object({id,version:z.number().int().min(1).max(1000000),title:label,
  sections:z.array(z.object({title:label,stepId:id}).strict()).min(1).max(64)}).strict(),
}).strict();
export type Workflow=z.infer<typeof workflowSchema>;
export function validateWorkflow(input:unknown,descriptor:PackageDescriptor):Workflow {
 const parsed=workflowSchema.safeParse(input);
 if(!parsed.success)throw new Error('ARTIFACT_INVALID_WORKFLOW');
 const flow=parsed.data,pkg=validateDescriptor(descriptor),ids=new Set(flow.steps.map(s=>s.id));
 if(ids.size!==flow.steps.length)throw new Error('ARTIFACT_INVALID_WORKFLOW');
 const visited=new Set<string>(),visiting=new Set<string>();
 function walk(key:string){
  if(visiting.has(key))throw new Error('ARTIFACT_INVALID_WORKFLOW');
  if(visited.has(key))return;
  const step=flow.steps.find(s=>s.id===key);if(!step)throw new Error('ARTIFACT_INVALID_WORKFLOW');
  visiting.add(key);step.dependsOn.forEach(walk);visiting.delete(key);visited.add(key);
 }
 for(const step of flow.steps){
  if(step.minLength>step.maxLength || new Set(step.dependsOn).size!==step.dependsOn.length ||
   step.resources.some(path=>!pkg.files.some(f=>f.path===path)) ||
   (step.requiresEvidence&&!step.requiredCapabilities.includes('research.evidence')))throw new Error('ARTIFACT_INVALID_WORKFLOW');
  walk(step.id);
 }
 if(flow.report.sections.some(s=>!ids.has(s.stepId)) || flow.steps.some(s=>!flow.report.sections.some(r=>r.stepId===s.id)))throw new Error('ARTIFACT_INVALID_WORKFLOW');
 return flow;
}
