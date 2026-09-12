/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {workbenchService} from '../artifacts/workbench';

const uuid=z.string().uuid();
// Constructed and persisted by the admission service from a selected report,
// never accepted as a model tool argument. No latest-version lookup.
export const formalArtifactSelection=z.object({
 projectId:uuid,roundId:uuid,versionId:uuid,version:z.number().int().positive(),
 hash:z.string().regex(/^[a-f0-9]{64}$/),targetProjectId:uuid,targetRoundId:uuid,
 account:z.string().min(1).max(160),
 sections:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(32)
  .refine(value=>new Set(value).size===value.length),
 maxChars:z.number().int().min(1).max(20000),
}).strict();

export function bindFormalArtifactReader(
 workbench:Pick<ReturnType<typeof workbenchService>,'projects'|'read'|'report'>,
 selection:z.infer<typeof formalArtifactSelection>,
) {
 const fixed=formalArtifactSelection.parse(selection);
 return async()=>{
  // Both endpoints remain subject to current ownership, method and evidence
  // access. Reuse the existing report reader, not a copied source body.
  const projects=await workbench.projects();
  const source=projects.find(project=>project.projectId===fixed.projectId);
  const target=projects.find(project=>project.projectId===fixed.targetProjectId);
  if(!source||!target||(source.linkedAccount??source.account)!==fixed.account ||
   (target.linkedAccount??target.account)!==fixed.account)throw new Error('ARTIFACT_DENIED');
  await workbench.read(fixed.targetProjectId,fixed.targetRoundId);
  const report=await workbench.report(fixed.projectId,fixed.roundId);
  if(!report.available||!report.report||report.id!==fixed.versionId||report.version!==fixed.version||report.hash!==fixed.hash)throw new Error('ARTIFACT_EVIDENCE_UNAVAILABLE');
  const sections=fixed.sections.map(id=>{
   const section=report.report!.sections.find(section=>section.stepId===id);
   if(!section)throw new Error('ARTIFACT_EVIDENCE_UNAVAILABLE');
   return {title:section.title,body:section.body};
  });
  if(sections.reduce((count,section)=>count+section.body.length,0)>fixed.maxChars)throw new Error('GENERATION_CAPACITY');
  // Evidence IDs are deliberately not exposed as target-project evidence.
  // The execution admission/persistence path must bind target provenance.
  return JSON.stringify({kind:'formal_report',version:fixed.version,sections});
 };
}
