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
