/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { VOICE_DOCUMENT_TYPES, voiceProfile, type VoiceDocumentLabel, type VoiceProfile } from './profile';
import type { VoiceStats } from './stats';

export type VoiceVersion = { id: string; version: number;
  status: 'generating' | 'draft' | 'confirmed' | 'superseded' | 'stale' | 'failed';
  profile: VoiceProfile | null; failure: string | null; createdAt: string; confirmedAt: string | null;
  sources: Array<{ documentId: string; filename: string | null }>;
  /** VOICE-2 PR-1 (0539): null/empty for versions made before. The page shows them from PR-4. */
  stats?: VoiceStats | null; documents?: Array<VoiceDocumentLabel & { edited?: boolean }> };
export type VoiceState = { enabled: boolean; revision: number; needsUpdate: boolean;
  confirmed: VoiceVersion | null; latest: VoiceVersion | null;
  documents: Array<{ id: string; filename: string | null; textBytes: number; contentVersion: number; createdAt: string; preferred: boolean }> };

/** Exact 0341/library refusals reach the page; anything else is "unavailable", never database detail. */
export async function voiceRpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(/^(VOICE|LIBRARY)_[A-Z_]+$/.test(message) ? message : 'VOICE_UNAVAILABLE');
  }
  return result.data as T;
}

const uuid = z.string().uuid();
export const confirmInput = z.object({ versionId: uuid, expectedRevision: z.number().int().positive(), profile: voiceProfile }).strict();
export const enabledInput = z.object({ expectedRevision: z.number().int().positive(), enabled: z.boolean() }).strict();
export const generateInput = z.object({ requestId: uuid, preferred: z.array(uuid).max(20).default([]) }).strict();
/** VOICE-2 PR-4: the user corrects one document's type or topics on a version of their own (0539 voice_document_label_set). */
export const labelInput = z.object({ versionId: uuid, documentId: uuid, type: z.enum(VOICE_DOCUMENT_TYPES),
  topics: z.array(z.string().trim().min(1).max(20)).max(5) }).strict();

export function voiceService(admin: SupabaseClient, actorId: string) {
  return {
    state: () => voiceRpc<VoiceState>(admin, 'voice_state', { a: actorId }),
    confirm: (input: z.infer<typeof confirmInput>) => voiceRpc<VoiceState>(admin, 'voice_profile_confirm',
      { a: actorId, vid: input.versionId, expected_revision: input.expectedRevision, result: input.profile }),
    setEnabled: (input: z.infer<typeof enabledInput>) => voiceRpc<VoiceState>(admin, 'voice_profile_set_enabled',
      { a: actorId, expected_revision: input.expectedRevision, on_off: input.enabled }),
    remove: (versionId: string) => voiceRpc<VoiceState>(admin, 'voice_profile_delete', { a: actorId, vid: versionId }),
    setLabel: (input: z.infer<typeof labelInput>) => voiceRpc<VoiceState>(admin, 'voice_document_label_set',
      { a: actorId, vid: input.versionId, did: input.documentId, label_type: input.type, topics: input.topics }),
  };
}
