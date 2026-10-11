/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { changeConsent, consentErrorMessage, consentStatus, type DataUseConsentState } from './dataUseConsent';

const base: DataUseConsentState = {
  purpose: 'team_improvement', currentVersion: 'd5-v1', granted: false, version: null, grantedAt: null, revokedAt: null,
};

describe('data-use consent helpers', () => {
  it('derives the status from the server state', () => {
    expect(consentStatus(base)).toBe('never');
    expect(consentStatus({ ...base, granted: true, version: 'd5-v1', grantedAt: 'x' })).toBe('granted');
    expect(consentStatus({ ...base, version: 'd5-v1', grantedAt: 'x', revokedAt: 'y' })).toBe('revoked');
    expect(consentStatus({ ...base, currentVersion: 'd5-v2', version: 'd5-v1', grantedAt: 'x' })).toBe('outdated');
  });

  it('maps server error codes to readable messages', () => {
    expect(consentErrorMessage(new Error('DATA_USE_VERSION_STALE'))).toContain('说明已经更新');
    expect(consentErrorMessage(new Error('DATA_USE_ACCOUNT_CLOSED'))).toContain('账号已关闭');
    expect(consentErrorMessage(new Error('boom'))).toContain('暂时没能保存');
    expect(consentErrorMessage(null)).toContain('暂时没能保存');
  });

  it('reports an error when the server did not make the requested change', async () => {
    const set = vi.fn().mockResolvedValue(base);
    expect(await changeConsent(true, set)).toEqual({ error: '暂时没能保存，请稍后重试。' });
  });

  it('returns the saved state on success and the stale-version message on conflict', async () => {
    const saved = { ...base, granted: true, version: 'd5-v1', grantedAt: 'x' };
    expect(await changeConsent(true, vi.fn().mockResolvedValue(saved))).toEqual({ state: saved });
    const stale = await changeConsent(true, vi.fn().mockRejectedValue(new Error('DATA_USE_VERSION_STALE')));
    expect(stale.error).toContain('说明已经更新');
  });
});
