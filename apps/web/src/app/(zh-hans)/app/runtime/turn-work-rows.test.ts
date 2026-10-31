/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { workRowsOf } from './turn-work-rows';

describe('work rows read back after a reload', () => {
  it('gives one row per subcall under the reply, with what was asked and its credits', () => {
    const rows = workRowsOf([{ turnId: 7, seq: 2, toolName: 'web_search', status: 'ok', q: 100, multiplier: '6',
      arguments: '{"query":"早起"}', usage: { results: [{ outcome: 'ok', items: 3, costUsd: '0.005' }, { outcome: 'unknown', items: 0, costUsd: null }] } }]);
    expect(rows.get(7)).toMatchObject([{ label: '搜索 早起', state: 'done', credits: '3 积分' }, { state: 'pending', credits: null }]);
  });
  it('a receipt with no recorded question still shows its row', () => {
    const rows = workRowsOf([{ turnId: 7, seq: 2, toolName: 'web_fetch', status: 'ok', q: 100, multiplier: '6', arguments: null,
      usage: { results: [{ outcome: 'failed', items: 0, costUsd: null }] } }]);
    expect(rows.get(7)).toMatchObject([{ label: '搜索', state: 'missing' }]);
  });
});
