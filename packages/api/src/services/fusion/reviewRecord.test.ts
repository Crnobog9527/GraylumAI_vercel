/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reviewRecord } from './reviewRecord';

const id = '00000000-0000-4000-8000-000000000001';
const failing = (message: string) => ({ rpc: async () => ({ data: null, error: { message } }) }) as unknown as SupabaseClient;

describe('review record errors', () => {
  it('passes the adoption conflict through; anything unknown stays a generic failure', async () => {
    const adoption = { state: 'reserved' as const, requestId: id, choices: [], decision: 'apply' as const };
    await expect(reviewRecord(failing('FUSION_REVIEW_ADOPTED'), id).recordAdoption(id, adoption)).rejects.toThrow('FUSION_REVIEW_ADOPTED');
    await expect(reviewRecord(failing('some internal detail'), id).recordAdoption(id, adoption)).rejects.toThrow('FUSION_REVIEW_UNAVAILABLE');
  });
});

describe('a review on the turn path', () => {
  // The database derives these with md5(...)::uuid: no version or variant bits, so the strict uuid() check refused them and every
  // read of a turn-path review (continue, events, detail) failed (staging, 2026-11-01).
  const derived = { group: '8fccb794-42a6-1cc5-fc2b-82a78ac9fc34', call: 'd41a8a63-a428-7f12-fd36-a2e96b5a1221' };
  const turnView = { reviewId: id, state: 'paused', round: 1, phase: 'review', attempt: 1, draftId: id, sourceVersionId: id, sourceSessionId: id,
    versionHash: 'h', materials: {}, materialsHash: 'a'.repeat(64), config: {}, outcome: null, revisionId: null, endedAt: null, turnId: 62,
    steps: [{ round: 1, phase: 'review', attempt: 1, groupId: derived.group, stepKey: 'review:1:review:1', claimedAt: '2026-11-01T13:38:58+00:00' }],
    calls: [{ groupId: derived.group, runId: derived.call, callId: derived.call, modelId: id, phase: 'fusion_review', dispatched: true,
      verdict: 'usable', settled: true, state: 'ok', seq: 2 }] };
  it('reads the ids the database derives, which are not RFC uuids', async () => {
    const admin = { rpc: async () => ({ data: turnView, error: null }) } as unknown as SupabaseClient;
    const view = await reviewRecord(admin, id).read(id);
    expect(view?.calls[0]?.callId).toBe(derived.call);
    expect(view?.steps[0]?.groupId).toBe(derived.group);
  });
});
