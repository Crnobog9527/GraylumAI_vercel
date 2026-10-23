/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  captionTooLong, jobSummary, newIdempotencyKey, publishErrorMessage, publishTargets, type Connection,
} from './publish-flow';

const BIZ = '00000000-0000-4000-8000-000000000b01';
const conn = (id: string, platform: string, extra: Partial<Connection> = {}): Connection => ({ id, businessId: BIZ,
  accountProjectId: id, role: 'own', source: 'postforme', platform, displayHint: null, status: 'connected',
  consentPublish: true, ...extra });

describe('publish targets', () => {
  it('lists only this brand\'s own connected Post for Me accounts on open platforms', () => {
    const list = [conn('a', 'youtube'), conn('b', 'x', { consentPublish: false }), conn('c', 'tiktok'),
      conn('d', 'x', { businessId: 'other' }), conn('e', 'x', { role: 'benchmark' }), conn('f', 'x', { source: 'tikhub' }),
      conn('g', 'x', { status: 'reauth_required' })];
    expect(publishTargets(list, BIZ, ['x', 'youtube']).map(t => [t.id, t.ready])).toEqual([['b', false], ['a', true]]);
    expect(publishTargets(list, BIZ, [])).toEqual([]);
  });
});

describe('texts and keys', () => {
  it('warns per platform about long captions, counting characters, not bytes', () => {
    expect(captionTooLong('字'.repeat(280), ['x', 'youtube'])).toEqual([]);
    expect(captionTooLong('字'.repeat(281), ['x', 'youtube', 'bluesky'])).toEqual(['x']);
  });

  it('every attempt gets a fresh key the server accepts', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it('a full publishing channel reads as busy, never as a quota; unknown codes stay generic', () => {
    expect(publishErrorMessage('PUBLISH_MONITOR_QUOTA_EXHAUSTED')).toContain('发布通道暂时繁忙');
    expect(publishErrorMessage('PUBLISH_MONITOR_INSUFFICIENT_CREDITS')).toContain('充值');
    expect(publishErrorMessage('SOMETHING_RAW')).toBe('发布暂时没有完成，请稍后重试。');
    expect(publishErrorMessage('rate_limited', 'TOO_MANY_REQUESTS')).toContain('稍后再试');
  });

  it('an open result says credits are held and nothing is sent twice', () => {
    expect(jobSummary('unknown', false)).toContain('不会重复发');
    expect(jobSummary('unknown', true)).toContain('人工核对');
    expect(jobSummary('released', false)).toContain('退回');
  });
});
