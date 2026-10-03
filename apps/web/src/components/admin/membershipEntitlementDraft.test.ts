/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  bytesToMbText, describeBytes, fusionCompareInput, mbTextToBytes, planDraftFromRow, planUpdateInput, readFusionCompareLimit,
} from './membershipEntitlementDraft';

const plan = { id: '00000000-0000-4000-8000-000000000001', name: 'Free', level: 'free', allow_export: 'true',
  allow_batch_export: 'false', allow_fusion_review: false, allow_fusion_compare: true, library_storage_bytes: 50_000_000 };

describe('membership storage in decimal MB', () => {
  it.each([
    [50_000_000, '50'], [500_000_000, '500'], [2_000_000_000, '2000'], [0, '0'], [1, '0.000001'], [1_500_000, '1.5'],
    [Number.MAX_SAFE_INTEGER, '9007199254.740991'],
  ])('round-trips %d bytes exactly', (bytes, text) => {
    expect(bytesToMbText(bytes)).toBe(text);
    expect(mbTextToBytes(text)).toBe(bytes);
  });

  it.each(['', '-1', '1.2345678', 'abc', '1e3', '01', '1.', ' ', '9007199254.740992', '99999999999'])('rejects %j', (text) => {
    expect(mbTextToBytes(text)).toBeNull();
  });

  it('describes sizes in decimal units with the exact byte count', () => {
    expect(describeBytes(50_000_000)).toBe('50 MB（50,000,000 字节）');
    expect(describeBytes(2_000_000_000)).toBe('2 GB（2,000,000,000 字节）');
    expect(describeBytes(0)).toContain('不允许新增上传');
  });
});

describe('plan update input', () => {
  it('sends every permission explicitly with exact bytes', () => {
    const draft = { ...planDraftFromRow(plan), allowFusionReview: true, storageMb: '1.5' };
    expect(planUpdateInput(plan.id, draft)).toEqual({
      id: plan.id, allowExport: 'true', allowBatchExport: 'false', allowFusionReview: true, allowFusionCompare: true,
      libraryStorageBytes: 1_500_000,
    });
  });

  it('builds nothing for an invalid storage amount', () => {
    expect(planUpdateInput(plan.id, { ...planDraftFromRow(plan), storageMb: '-5' })).toBeNull();
  });
});

describe('Fusion compare limit', () => {
  it('reads only what the server accepts: a JSON integer 2–8', () => {
    expect([2, 4, 8].map(readFusionCompareLimit)).toEqual([2, 4, 8]);
    expect([1, 9, 4.5, '4', null, undefined].map(readFusionCompareLimit)).toEqual([null, null, null, null, null, null]);
  });

  it('accepts typed integers 2–8 only', () => {
    expect(['2', ' 8 '].map(fusionCompareInput)).toEqual([2, 8]);
    expect(['1', '9', '4.5', '', '-4', 'four'].map(fusionCompareInput)).toEqual([null, null, null, null, null, null]);
  });
});
