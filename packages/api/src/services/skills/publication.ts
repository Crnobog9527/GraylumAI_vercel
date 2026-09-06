import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { fail, packageHashPayload, sha256, validateDescriptor } from './loader';
import { parseSkillEntry } from './format';

export const packagePublicationInput = z.object({
  id: z.string().uuid(), revisionId: z.string().uuid(), requestId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  // Explicit administrator attestation, not automatic interpretation of prose.
  resourcePlanReviewed: z.literal(true),
  descriptor: z.unknown(),
  files: z.array(z.object({ path: z.string().max(240), base64: z.string().max(2_800_000) }).strict()).min(1).max(64),
}).strict();
export type PackagePublication = z.infer<typeof packagePublicationInput>;

/** Only call behind adminProcedure; this service never reads environment credentials. */
export async function publishSkillPackage(db: SupabaseClient, actorId: string, value: PackagePublication) {
  const input = packagePublicationInput.parse(value);
  const p = validateDescriptor(input.descriptor);
  if (p.packageId !== input.id || p.revisionId !== input.revisionId || input.files.length !== p.files.length) fail('INVALID_PACKAGE');
  if (p.files.some(f => /[^\x20-\x7e]/.test(f.path))) fail('UNSUPPORTED_CAPABILITY');
  const seen = new Set<string>();
  const files = input.files.map(file => {
    if (seen.has(file.path)) fail('INVALID_PACKAGE');
    seen.add(file.path);
    const meta = p.files.find(f => f.path === file.path);
    const bytes = Buffer.from(file.base64, 'base64');
    if (!meta || bytes.toString('base64') !== file.base64 || bytes.length !== meta.bytes || sha256(bytes) !== meta.sha256) fail('INTEGRITY_MISMATCH');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail('INVALID_FORMAT'); }
    if (text.includes('\0')) fail('INVALID_FORMAT');
    if (file.path === 'SKILL.md') {
      const parsed = parseSkillEntry(text, p.directoryName);
      if (!parsed.report.standard.valid || !parsed.report.compatibility.supported) fail('INVALID_FORMAT');
    }
    return { path: file.path, base64: file.base64 };
  });
  const { data, error } = await db.rpc('atomic_publish_skill_package', {
    p_skill_id: input.id, p_actor_id: actorId, p_revision_id: input.revisionId,
    p_request_id: input.requestId, p_expected_version: input.expectedVersion,
    p_manifest: p, p_hash_payload: packageHashPayload(p), p_files: files,
  });
  if (error || !data) fail('SOURCE_FAILURE');
  return { revisionId: input.revisionId, packageHash: p.packageHash, version: Number(data) };
}
