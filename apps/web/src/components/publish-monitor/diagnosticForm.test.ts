/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RATE_KEYS } from '@repo/api/src/services/publishMonitor/rateKeys';
import { describe, expect, it } from 'vitest';
import { buildDiagnostic, rateLabel, RATE_FIELDS, showRate, type DiagnosticForm } from './diagnosticForm';

const post = '00000000-0000-4000-8000-0000000f0002';
const form = (over: Partial<DiagnosticForm> = {}): DiagnosticForm => ({ postId: post, rates: { bounce_2s: '42' }, videoSeconds: '', dropSecond: '',
  openingText: '', ...over });

describe('the diagnosis form', () => {
  it('turns what the back office shows into the fractions the server stores, and leaves blanks out', () => {
    const built = buildDiagnostic(form({ rates: { bounce_2s: '42%', retain_3s: ' 31.5 ', complete_rate: '', avg_watch_seconds: '7.5秒', like_rate: '0' },
      videoSeconds: '30', dropSecond: '4', openingText: '  这家店的隐藏菜单  ' }));
    expect(built).toEqual({ ok: true, input: { postId: post, rates: { bounce_2s: 0.42, retain_3s: 0.315, avg_watch_seconds: 7.5, like_rate: 0 },
      openingText: '这家店的隐藏菜单', videoSeconds: 30, dropSecond: 4 } });
    // A typed zero is a real zero; a blank is absent.
    expect(Object.keys((built as { input: { rates: object } }).input.rates)).not.toContain('complete_rate');
  });

  it('names every problem next to the field instead of sending it: no post, nothing filled, unreadable or out-of-range numbers, bad lengths', () => {
    const problems = (over: Partial<DiagnosticForm>) => { const r = buildDiagnostic(form(over)); return r.ok ? [] : r.problems; };
    expect(problems({ postId: '' })).toEqual(['POST']);
    expect(problems({ rates: {} })).toEqual(['EMPTY']);
    expect(problems({ rates: { bounce_2s: '   ' } })).toEqual(['EMPTY']);
    for (const bad of ['abc', '-5', '101', '4,2', '1e2', '0.4.2', '42 %%']) expect(problems({ rates: { bounce_2s: bad } }), bad).toContain('RATE');
    expect(problems({ rates: { avg_watch_seconds: '90000' } })).toContain('RATE');
    expect(problems({ videoSeconds: '0' })).toEqual(['VIDEO']);
    expect(problems({ videoSeconds: '12.5' })).toEqual(['VIDEO']);
    expect(problems({ dropSecond: '-1' })).toEqual(['DROP']);
    expect(problems({ videoSeconds: '10', dropSecond: '11' })).toEqual(['DROP_AFTER_END']);
    expect(problems({ openingText: '字'.repeat(2001) })).toEqual(['OPENING']);
    expect(problems({ videoSeconds: '10', dropSecond: '10', openingText: '字'.repeat(2000) })).toEqual([]);
  });

  it('has a field for every normalized rate key and no other, so the form cannot drift from the server', () => {
    expect(RATE_FIELDS.map(field => field.key).sort()).toEqual([...RATE_KEYS].sort());
    expect(rateLabel('bounce_2s')).toBe('2 秒跳出率');
    expect(rateLabel('made_up')).toBe('其他指标');
  });

  it('reads stored rates back the way they were typed', () => {
    expect(showRate('bounce_2s', 0.42)).toBe('42%');
    expect(showRate('retain_3s', 0.315)).toBe('31.5%');
    expect(showRate('avg_watch_seconds', 7.5)).toBe('7.5 秒');
  });
});
