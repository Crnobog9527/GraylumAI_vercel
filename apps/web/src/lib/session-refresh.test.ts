/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionRefresher, isSessionRefreshRequired, SESSION_MIN_REMAINING_MS, SESSION_REFRESH_REQUIRED_MESSAGE,
} from './session-refresh';

const NOW = 1_800_000_000_000;
const session = (secondsLeft: number, token = 'old') => ({ data: { session: { access_token: token, expires_at: (NOW / 1000) + secondsLeft } } });
function refresher(secondsLeft: number | null, refreshed: { token?: string; error?: unknown; reject?: boolean } = { token: 'new' }) {
  const onToken = vi.fn();
  const refreshSession = vi.fn(async () => {
    if (refreshed.reject) throw new Error('network');
    return { data: { session: refreshed.token ? { access_token: refreshed.token } : null }, error: refreshed.error };
  });
  const getSession = vi.fn(async () => secondsLeft === null ? { data: { session: null } } : session(secondsLeft));
  return { onToken, refreshSession, getSession, r: createSessionRefresher({ getSession, refreshSession, onToken, now: () => NOW }) };
}

describe('isSessionRefreshRequired', () => {
  it('matches exactly the Runtime refusal the server sends', () => {
    // The server's mapping (stagingErrors.ts) must keep this text, or the client stops recognising it.
    const server = readFileSync(new URL('../../../../packages/api/src/services/runtime/stagingErrors.ts', import.meta.url), 'utf8');
    expect(server).toContain(`RUNTIME_STAGING_AUTH_REFRESH_REQUIRED: ['PRECONDITION_FAILED', '${SESSION_REFRESH_REQUIRED_MESSAGE}']`);
    expect(isSessionRefreshRequired(new Error(SESSION_REFRESH_REQUIRED_MESSAGE))).toBe(true);
    expect(isSessionRefreshRequired({ message: 'RUNTIME_STAGING_AUTH_REFRESH_REQUIRED' })).toBe(true);
    for (const other of [new Error('当前登录账号未获准访问此测试工作空间。'), new Error('UNAUTHORIZED'), null, 'x'])
      expect(isSessionRefreshRequired(other)).toBe(false);
  });
});

describe('createSessionRefresher', () => {
  it('refreshes ahead of a request only when the token is about to run short', async () => {
    const short = refresher(SESSION_MIN_REMAINING_MS / 1000 - 1);
    await short.r.ensureFresh();
    expect(short.refreshSession).toHaveBeenCalledTimes(1);
    expect(short.onToken).toHaveBeenCalledWith('new');
    const fresh = refresher(3600);
    await fresh.r.ensureFresh();
    expect(fresh.refreshSession).not.toHaveBeenCalled();
  });
  it('never blocks a request without a session or when the check fails', async () => {
    const none = refresher(null);
    await expect(none.r.ensureFresh()).resolves.toBeUndefined();
    expect(none.refreshSession).not.toHaveBeenCalled();
    const failing = refresher(10, { reject: true });
    await expect(failing.r.ensureFresh()).resolves.toBeUndefined();
  });
  it('reports a failed refresh and keeps the old token', async () => {
    for (const result of [{ token: undefined }, { token: 'x', error: new Error('invalid refresh token') }, { reject: true }]) {
      const t = refresher(10, result);
      expect(await t.r.refresh()).toBe(false);
      expect(t.onToken).not.toHaveBeenCalled();
    }
  });
  it('shares one refresh between concurrent callers', async () => {
    const t = refresher(10);
    expect(await Promise.all([t.r.refresh(), t.r.refresh(), t.r.ensureFresh()])).toEqual([true, true, undefined]);
    expect(t.refreshSession).toHaveBeenCalledTimes(1);
    await t.r.refresh();
    expect(t.refreshSession).toHaveBeenCalledTimes(2);
  });
});
