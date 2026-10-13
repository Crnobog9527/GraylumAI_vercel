import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingEmail,
  PENDING_EMAIL_TTL_MS,
  readPendingEmail,
  rememberPendingEmail,
  restorePendingEmail,
  takeLegacyEmailParam,
} from './pendingAuthEmail';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    size: () => data.size,
  };
}

describe('pending auth email', () => {
  it('keeps a remembered email for this tab until it expires', () => {
    const store = memoryStore();
    rememberPendingEmail(' a+b@example.test ', store, 1_000);
    expect(readPendingEmail(store, 1_000 + PENDING_EMAIL_TTL_MS - 1)).toBe('a+b@example.test');
    expect(readPendingEmail(store, 1_000 + PENDING_EMAIL_TTL_MS)).toBe('');
    expect(store.size()).toBe(0);
  });

  it('clears on demand and on an empty email, and ignores unreadable entries', () => {
    const store = memoryStore();
    rememberPendingEmail('a@example.test', store);
    clearPendingEmail(store);
    expect(readPendingEmail(store)).toBe('');
    rememberPendingEmail('a@example.test', store);
    rememberPendingEmail('  ', store);
    expect(store.size()).toBe(0);
    store.setItem('graylum:pending-auth-email', '{not json');
    expect(readPendingEmail(store)).toBe('');
    store.setItem('graylum:pending-auth-email', JSON.stringify({ email: 'a@example.test', savedAt: Date.now() + 60_000 }));
    expect(readPendingEmail(store)).toBe('');
  });

  it('works without storage (blocked or server side)', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(() => rememberPendingEmail('a@example.test', throwing)).not.toThrow();
    expect(readPendingEmail(throwing)).toBe('');
    expect(readPendingEmail(null)).toBe('');
  });

  it('moves an old ?email= into storage and leaves the rest of the query', () => {
    const store = memoryStore();
    expect(takeLegacyEmailParam('?redirect=%2Fprofile', store)).toBeNull();
    expect(takeLegacyEmailParam('?email=a%2Bb%40example.test&redirect=%2Fprofile&reason=signup', store))
      .toEqual({ email: 'a+b@example.test', search: '?redirect=%2Fprofile&reason=signup' });
    expect(readPendingEmail(store)).toBe('a+b@example.test');
    expect(takeLegacyEmailParam('?email=', store)).toEqual({ email: '', search: '' });
  });

  it('rewrites the address bar only when an old ?email= is there, keeping the fragment', () => {
    const store = memoryStore();
    const replaceState = vi.fn();
    const win = (search: string) => ({ location: { pathname: '/verify-email', search, hash: '#error_code=otp_expired' }, history: { replaceState } });

    expect(restorePendingEmail(win('?redirect=%2F'), store)).toBe('');
    expect(replaceState).not.toHaveBeenCalled();

    expect(restorePendingEmail(win('?email=a%40example.test&redirect=%2F'), store)).toBe('a@example.test');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/verify-email?redirect=%2F#error_code=otp_expired');

    replaceState.mockClear();
    expect(restorePendingEmail(win('?redirect=%2F'), store)).toBe('a@example.test');
    expect(replaceState).not.toHaveBeenCalled();
  });
});
