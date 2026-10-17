import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFirstTouch, clearFirstTouch, firstTouchForSignup } from './attribution';

const ORIGIN = 'https://auth-staging.graylum.com';
const NOW = Date.parse('2026-10-17T10:00:00Z');
let store: Record<string, string>;
let consent: boolean;
beforeEach(() => {
  store = {}; consent = true;
  vi.stubGlobal('window', {
    Termly: { getConsentState: () => ({ analytics: consent }) },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; } },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('first touch', () => {
  it('keeps the first landing only, cleaned, while consent is live', () => {
    captureFirstTouch(`${ORIGIN}/positioning/draft-1?utm_source=YouTube&utm_campaign=Alice.Smith&email=a@b.c`,
      'https://chatgpt.com/c/private-thread', NOW);
    captureFirstTouch(`${ORIGIN}/faq?utm_source=reddit`, 'https://reddit.com/r/x', NOW);
    expect(firstTouchForSignup(NOW)).toEqual({ utm_source: 'youtube', referrer_host: 'chatgpt.com',
      landing_path: '/positioning/[draftId]', first_seen_at: '2026-10-17T10:00:00.000Z' });
    expect(JSON.stringify(store)).not.toMatch(/draft-1|Alice|a@b\.c|private-thread/);
  });

  it('stores nothing without consent, ignores own-site referrers and sensitive landing paths', () => {
    consent = false;
    captureFirstTouch(`${ORIGIN}/landing?utm_source=youtube`, '', NOW);
    expect(store).toEqual({});
    consent = true;
    captureFirstTouch(`${ORIGIN}/verify-email?email=a@b.c`, `${ORIGIN}/register`, NOW);
    expect(firstTouchForSignup(NOW)).toEqual({ first_seen_at: '2026-10-17T10:00:00.000Z' });
  });

  it('consent → withdraw → sign up sends nothing (acceptance)', () => {
    captureFirstTouch(`${ORIGIN}/landing?utm_source=youtube`, '', NOW);
    consent = false;
    expect(firstTouchForSignup(NOW)).toBeNull();
    clearFirstTouch();
    consent = true;
    expect(firstTouchForSignup(NOW)).toBeNull();
  });
});
