/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {assertPath, identityOf, readSkillResource, type SkillSource} from './loader';
import {parseWorkflowManifest, workflowManifestPath} from './workflowManifest';

/** Existing generic Runtime contract, now frozen explicitly for undeclared legacy packages. */
export const GENERIC_ORGANIZER_TEMPLATE =
  'Organize this operation result. Preserve provenance and uncertainty. Do not add new facts.';

// Leave room for the host's extraction protocol and opening/answer-card rules (12,000 characters).
export const ORGANIZER_TEMPLATE_MAX_BYTES = 3000;
export function validateOrganizerTemplate(path: string, bytes: Uint8Array): string {
  assertPath(path);
  if (!path.endsWith('.md') || bytes.byteLength > ORGANIZER_TEMPLATE_MAX_BYTES)
    throw new Error('SKILL_ORGANIZER_TEMPLATE_INVALID');
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new Error('SKILL_ORGANIZER_TEMPLATE_INVALID'); }
  if (!text.trim() || text.includes('\0')) throw new Error('SKILL_ORGANIZER_TEMPLATE_INVALID');
  return text;
}

/** The immutable package, not today's module version, is the template authority. */
export async function loadOrganizerTemplate(source: SkillSource, revisionId: string): Promise<string | undefined> {
  const descriptor = (await source.list()).find(item => item.revisionId === revisionId);
  if (!descriptor) throw new Error('RUNTIME_REVISION_DENIED');
  if (!descriptor.files.some(item => item.path === workflowManifestPath)) return undefined;
  const manifest = parseWorkflowManifest(await readSkillResource(source, identityOf(descriptor), workflowManifestPath, 2 * 1024 * 1024));
  if (manifest.organizerTemplate === undefined) return undefined;
  const text = await readSkillResource(source, identityOf(descriptor), manifest.organizerTemplate, ORGANIZER_TEMPLATE_MAX_BYTES);
  return validateOrganizerTemplate(manifest.organizerTemplate, Buffer.from(text));
}
