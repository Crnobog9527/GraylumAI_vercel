import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsAllowed, bindConsentedTool, CHOICE_KEY, closeConsentPreferences, consentSnapshot, denyConsent, grantConsent,
  openConsentPreferences, resetConsentForTests, subscribeConsent,
} from './consent';

// A small browser: cookies, localStorage, the GPC flag and the storage event.
let cookies: string[];
let store: Record<string, string>;
let gpc: boolean | undefined;
let storageListener: ((event: { key: string | null }) => void) | null;
const written: string[] = [];

function browser({ region, choice, globalPrivacyControl }: {
  region?: string; choice?: 'granted' | 'denied'; globalPrivacyControl?: boolean;
} = {}) {
  cookies = region ? [`other=1`, `gl_consent_region=${region}`] : ['other=1'];
  store = choice ? { [CHOICE_KEY]: JSON.stringify({ choice, at: '2026-11-07T00:00:00.000Z' }) } : {};
  gpc = globalPrivacyControl;
}

beforeEach(() => {
  resetConsentForTests();
  browser();
  written.length = 0;
  storageListener = null;
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    location: { hostname: 'www.graylum.com' },
    addEventListener: (name: string, listener: (event: { key: string | null }) => void) => {
      if (name === 'storage') storageListener = listener;
    },
    removeEventListener: () => { storageListener = null; },
  });
  vi.stubGlobal('document', {
    get cookie() { return cookies.join('; '); },
    set cookie(value: string) { written.push(value); },
  });
  vi.stubGlobal('navigator', { get globalPrivacyControl() { return gpc; } });
});
afterEach(() => { resetConsentForTests(); vi.unstubAllGlobals(); });

describe('statistics consent (ANALYTICS-CONSENT)', () => {
  it('opt-out region: allowed by default, no bar', () => {
    browser({ region: 'optout' });
    expect(analyticsAllowed()).toBe(true);
    expect(consentSnapshot()).toMatchObject({ ready: true, region: 'optout', choice: null, analytics: true, promptOpen: false });
  });

  it('opt-in region: denied and the bar shows until the visitor accepts', () => {
    browser({ region: 'optin' });
    expect(analyticsAllowed()).toBe(false);
    expect(consentSnapshot()).toMatchObject({ region: 'optin', analytics: false, promptOpen: true, reopened: false });
    grantConsent();
    expect(analyticsAllowed()).toBe(true);
    expect(consentSnapshot().promptOpen).toBe(false);
    expect(JSON.parse(store[CHOICE_KEY]!)).toMatchObject({ choice: 'granted' });
  });

  it('a missing or unreadable region cookie counts as opt-in', () => {
    browser();
    expect(consentSnapshot()).toMatchObject({ region: 'optin', analytics: false, promptOpen: true });
    resetConsentForTests();
    browser({ region: 'somewhere' });
    expect(consentSnapshot()).toMatchObject({ region: 'optin', analytics: false });
  });

  it('a test override cookie reads as its region class', () => {
    browser({ region: 'test-optout' });
    expect(consentSnapshot()).toMatchObject({ region: 'optout', analytics: true });
  });

  it('a stored choice wins over the region default, and is remembered across page loads', () => {
    browser({ region: 'optin', choice: 'granted' });
    expect(consentSnapshot()).toMatchObject({ analytics: true, promptOpen: false });
    resetConsentForTests();
    browser({ region: 'optout', choice: 'denied' });
    expect(consentSnapshot()).toMatchObject({ analytics: false, promptOpen: false });
  });

  it('GPC is a refusal everywhere, whatever was stored, and the bar does not ask', () => {
    browser({ region: 'optout', globalPrivacyControl: true });
    expect(analyticsAllowed()).toBe(false);
    resetConsentForTests();
    browser({ region: 'optin', choice: 'granted', globalPrivacyControl: true });
    expect(consentSnapshot()).toMatchObject({ gpc: true, analytics: false, promptOpen: false });
    grantConsent();
    expect(analyticsAllowed()).toBe(false);
  });

  it('withdrawal stops statistics at once, tells subscribers and removes GA cookies', () => {
    browser({ region: 'optout' });
    cookies.push('_ga=GA1.1.123.456', '_ga_TEST123=GS1.1');
    const seen: boolean[] = [];
    subscribeConsent(() => seen.push(consentSnapshot().analytics));
    expect(analyticsAllowed()).toBe(true);
    denyConsent();
    expect(analyticsAllowed()).toBe(false);
    expect(seen).toEqual([false]);
    expect(JSON.parse(store[CHOICE_KEY]!)).toMatchObject({ choice: 'denied' });
    expect(written).toContain('_ga=; Max-Age=0; path=/');
    expect(written).toContain('_ga_TEST123=; Max-Age=0; path=/; domain=.graylum.com');
    expect(written.some(value => value.startsWith('other='))).toBe(false);
  });

  it('a choice made in another tab applies here at once', () => {
    browser({ region: 'optin', choice: 'granted' });
    expect(analyticsAllowed()).toBe(true);
    store[CHOICE_KEY] = JSON.stringify({ choice: 'denied' });
    storageListener?.({ key: CHOICE_KEY });
    expect(analyticsAllowed()).toBe(false);
  });

  it('"Cookie 设置" reopens the bar in every region and closes without changing the choice', () => {
    browser({ region: 'optout' });
    expect(consentSnapshot().promptOpen).toBe(false);
    expect(openConsentPreferences()).toBe(true);
    expect(consentSnapshot()).toMatchObject({ promptOpen: true, reopened: true, analytics: true });
    closeConsentPreferences();
    expect(consentSnapshot()).toMatchObject({ promptOpen: false, reopened: false, analytics: true, choice: null });
    openConsentPreferences();
    denyConsent();
    expect(consentSnapshot()).toMatchObject({ promptOpen: false, reopened: false, analytics: false });
  });

  it('closing a reopened bar does not dismiss a first-time opt-in visitor', () => {
    browser({ region: 'optin' });
    openConsentPreferences();
    closeConsentPreferences();
    expect(consentSnapshot()).toMatchObject({ promptOpen: true, reopened: false, analytics: false });
  });

  it('bindConsentedTool (for PostHog later) follows the same state', () => {
    browser({ region: 'optin' });
    const calls: string[] = [];
    const unbind = bindConsentedTool({ optIn: () => calls.push('in'), optOut: () => calls.push('out') });
    expect(calls).toEqual(['out']);
    grantConsent();
    openConsentPreferences();
    denyConsent();
    expect(calls).toEqual(['out', 'in', 'out']);
    unbind();
    grantConsent();
    expect(calls).toEqual(['out', 'in', 'out']);
  });

  it('works without storage: the choice holds for this page', () => {
    browser({ region: 'optin' });
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    resetConsentForTests();
    grantConsent();
    expect(analyticsAllowed()).toBe(true);
  });
});
