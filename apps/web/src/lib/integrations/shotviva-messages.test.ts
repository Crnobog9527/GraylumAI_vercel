/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { IMAGE_STEP_REASONS } from '@repo/api/src/services/turn/sse';
import { imageActionHref, imageCardMessage } from './shotviva-messages';

describe('Shotviva image card wording', () => {
  it('a face swap says 不支持换脸, charges nothing and offers no retry button (Owner 2026-11-07)', () => {
    const message = imageCardMessage('IDENTITY_SWAP_REFUSED');
    expect(message.text).toContain('不支持换脸');
    expect(message.text).toContain('没有扣');
    expect(message.action).toBeUndefined();
  });

  it('every reason the server can send has its own plain sentence; anything else reads as "unavailable"', () => {
    for (const reason of IMAGE_STEP_REASONS) {
      const text = imageCardMessage(reason).text;
      expect(text, reason).not.toMatch(/[A-Z_]{4,}/);
      expect(text.length).toBeGreaterThan(8);
    }
    expect(imageCardMessage('something_new')).toEqual(imageCardMessage('unavailable'));
    expect(imageCardMessage(undefined)).toEqual(imageCardMessage('unavailable'));
  });

  it('the button that helps: connect, upgrade, top up on Shotviva, or view the job', () => {
    expect(imageCardMessage('not_linked').action?.kind).toBe('connect');
    expect(imageCardMessage('link_revoked').action?.kind).toBe('connect');
    expect(imageCardMessage('membership_required').action?.kind).toBe('upgrade');
    expect(imageCardMessage('quota_exhausted').action?.kind).toBe('top_up');
    expect(imageActionHref({ kind: 'connect', label: '' }, {})).toBe('/app/integrations');
    expect(imageActionHref({ kind: 'upgrade', label: '' }, {})).toBe('/app/profile?tab=subscription');
    expect(imageActionHref({ kind: 'top_up', label: '' }, { topUpUrl: 'https://shotviva.test/pricing?from=graylum' }))
      .toBe('https://shotviva.test/pricing?from=graylum');
    expect(imageActionHref({ kind: 'top_up', label: '' }, {})).toBe('/app/integrations');
    expect(imageActionHref({ kind: 'view', label: '' }, {})).toBeNull();
  });
});
