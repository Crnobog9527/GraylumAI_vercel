/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArtifactSnapshot } from '../artifacts/public';

// 未完成、默认关闭。Only the server-side setting enables NEW report admission.
export const REPORT_SETTING = 'runtime_report_generation';
export const REPORT_INPUT_BYTES = 196608;
export const REPORT_FACT_BYTES = 81920;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
export const reportManifest = z.object({
  resources: z.array(z.string().min(1).max(240)).min(1).max(64),
  sections: z.array(label).min(1).max(64),
  maxCharacters: z.number().int().min(1).max(12000),
}).strict();
export const frozenReport = z.object({
  version: z.literal(1), projectId: z.string().uuid(), roundId: z.string().uuid(),
  evidenceIds: z.array(z.string().uuid()).max(2048).default([]),
  snapshotHash: hash, packageHash: hash, workflowHash: hash, templateHash: hash,
  sections: reportManifest.shape.sections, maxCharacters: reportManifest.shape.maxCharacters,
}).strict();
export type FrozenReport = z.infer<typeof frozenReport>;
export const reportStart = z.object({
  sessionId: z.string().uuid(), projectId: z.string().uuid(), roundId: z.string().uuid(), requestId: z.string().uuid(),
}).strict();
export function confirmedReportFacts(snapshot: ArtifactSnapshot) {
  if (!snapshot.workflow.steps.length || snapshot.state === 'abandoned') throw new Error('REPORT_SOURCE_CONFLICT');
  const facts = snapshot.workflow.steps.map(step => {
    const value = snapshot.steps[step.id];
    if (!value?.valid || !value.confirmationId || !value.body || value.available === false) {
      throw new Error('REPORT_CONFIRMATION_REQUIRED');
    }
    return { id: step.id, title: step.title, body: value.body, version: value.version,
      reviewVersion: value.reviewVersion, confirmationId: value.confirmationId,
      evidenceIds: value.evidenceIds, provenanceIds: value.provenanceIds };
  });
  const serialized = JSON.stringify(facts);
  if (Buffer.byteLength(serialized) > REPORT_FACT_BYTES) throw new Error('REPORT_FACTS_TOO_LARGE');
  return { serialized, snapshotHash: createHash('sha256').update(serialized).digest('hex') };
}

/** Structure validation only; never guesses user intent or supplies missing sections. */
export function completeReportCandidate(body: string, completeness: unknown, manifest: FrozenReport) {
  if (completeness !== 'complete' || [...body].length > manifest.maxCharacters) return false;
  const headings = body.split(/\r?\n/).filter(line => /^##\s+/.test(line)).map(line => line.replace(/^##\s+/, '').trim());
  return headings.length === manifest.sections.length && headings.every((title, index) => title === manifest.sections[index])
    && body.split(/^##\s+[^\r\n]+\r?$/m).slice(1).every(section => section.trim().length > 0);
}
