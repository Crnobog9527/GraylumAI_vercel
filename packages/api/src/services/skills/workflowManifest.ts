/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { parseDocument } from 'yaml';
import { z } from 'zod';

const label = z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
const path = z.string().min(1).max(240);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const informationSchema = z.object({
  id,title:label,required:z.boolean(),profileKey:id.optional(),
  elicitation:z.enum(['user_fact','agent_proposal']).optional(),
}).strict();
const manifestSchema = z.object({
  kind: z.enum(['document','social']),
  planResources: z.array(path).min(1).max(64).optional(),
  steps: z.array(z.object({
    title: label,
    resources: z.array(path).min(1).max(64),
    information: z.array(informationSchema).max(24).optional(),
  }).strict()).min(1).max(32),
}).strict();

export type WorkflowManifest = z.infer<typeof manifestSchema>;
export const workflowManifestPath = 'workflow.yaml';

/** A Skill's declared UI contract. Prose in SKILL.md is never guessed into fields. */
export function parseWorkflowManifest(source: string): WorkflowManifest {
  const document = parseDocument(source, {uniqueKeys:true,prettyErrors:false,logLevel:'silent'});
  if (document.errors.length || document.warnings.length) throw new Error('workflow.yaml 格式无效');
  let value: unknown;
  try { value = document.toJS({maxAliasCount:0}); }
  catch { throw new Error('workflow.yaml 不支持别名或自定义标签'); }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('workflow.yaml 的步骤或问题声明无效');
  return parsed.data;
}
