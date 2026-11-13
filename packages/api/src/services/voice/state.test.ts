/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { labelInput, voiceService } from './state';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('correcting a document label (VOICE-2 PR-4)', () => {
  it('takes a known type and at most five topics of at most twenty characters', () => {
    const ok = { versionId: uuid(1), documentId: uuid(2), type: 'script', topics: ['做饭'] };
    expect(labelInput.safeParse(ok).success).toBe(true);
    expect(labelInput.safeParse({ ...ok, type: 'tweet' }).success).toBe(false);
    expect(labelInput.safeParse({ ...ok, topics: ['1', '2', '3', '4', '5', '6'] }).success).toBe(false);
    expect(labelInput.safeParse({ ...ok, topics: ['话'.repeat(21)] }).success).toBe(false);
    expect(labelInput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it('calls voice_document_label_set for the signed-in account, and passes its refusal through', async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: true }, error: null }));
    const service = voiceService({ rpc } as unknown as SupabaseClient, uuid(9));
    await service.setLabel({ versionId: uuid(1), documentId: uuid(2), type: 'post', topics: ['健身'] });
    expect(rpc).toHaveBeenCalledWith('voice_document_label_set', { a: uuid(9), vid: uuid(1), did: uuid(2), label_type: 'post', topics: ['健身'] });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'VOICE_VERSION_GONE' } } as never);
    await expect(service.setLabel({ versionId: uuid(1), documentId: uuid(3), type: 'post', topics: [] })).rejects.toThrow('VOICE_VERSION_GONE');
  });
});
