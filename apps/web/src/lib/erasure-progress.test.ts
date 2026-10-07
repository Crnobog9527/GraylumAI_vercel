/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { clearErasureHandoff, describeProgressError, formatProgressCredential, parseProgressCredential,
  readErasureHandoff, saveErasureHandoff } from './erasure-progress';
import { decideUnauthorizedAction } from './auth-recovery';

const credential = { requestId: '00000000-0000-4000-8000-000000000001', token: 'a'.repeat(43) };
afterEach(() => vi.unstubAllGlobals());
it('roundtrips only the existing UUID and 32-byte base64url capability shape', () => {
  expect(parseProgressCredential(formatProgressCredential(credential))).toEqual(credential);
  for (const text of ['', 'https://site/?token=secret', `${credential.requestId}.${'a'.repeat(42)}`,
    `${credential.requestId}.${'/'.repeat(43)}`, `${formatProgressCredential(credential)}.extra`]) {
    expect(parseProgressCredential(text)).toBeNull();
  }
});
it('keeps only a session convenience copy, including an honest missing-capability handoff', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  expect(saveErasureHandoff({ closed: true, credential })).toBe(true);
  expect(readErasureHandoff()).toEqual({ closed: true, credential });
  expect(saveErasureHandoff({ closed: false, credential: null })).toBe(true);
  expect(readErasureHandoff()).toEqual({ closed: false, credential: null });
  expect(clearErasureHandoff()).toBe(true);
  expect(readErasureHandoff()).toBeNull();
});
it('contains corrupt or denied session storage without pretending a copy was saved', () => {
  vi.stubGlobal('window', { sessionStorage: { getItem: () => '{corrupt',
    setItem: () => { throw Error('denied'); }, removeItem: () => { throw Error('denied'); } } });
  expect(readErasureHandoff()).toBeNull();
  expect(saveErasureHandoff({ closed: true, credential })).toBe(false);
  expect(clearErasureHandoff()).toBe(false);
});
it('maps refusal and transient failures without echoing server content or claiming a fresh account', () => {
  expect(describeProgressError({ data: { code: 'NOT_FOUND' }, message: credential.token })).toContain('不代表注销未发生');
  expect(describeProgressError({ data: { code: 'TOO_MANY_REQUESTS' } })).toContain('频繁');
  expect(describeProgressError(new Error(credential.token))).not.toContain(credential.token);
});
it('never redirects the public progress page to login, while protected profile remains denied', () => {
  const state = { search: '', hasSession: false, sessionRefreshUsed: false, lastRedirectAt: null, now: 100 };
  expect(decideUnauthorizedAction({ ...state, pathname: '/account-erasure' })).toEqual({ kind: 'ignore' });
  expect(decideUnauthorizedAction({ ...state, pathname: '/profile' }).kind).toBe('redirect');
});
