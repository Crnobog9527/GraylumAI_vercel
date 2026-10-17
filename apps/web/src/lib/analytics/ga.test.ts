import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterPage, readGaCheckoutIds, resetGaForTests, sendGaEvent, syncGa } from './ga';

const ID = 'G-TEST123';
const ORIGIN = 'https://auth-staging.graylum.com';
type Fake = { dataLayer?: unknown[]; Termly?: unknown; [key: string]: unknown };

let win: Fake;
let appended: { src: string }[];
let consent = { analytics: false, advertising: false };

/** dataLayer entries as plain arrays (gtag pushes `arguments` objects). */
const calls = () => (win.dataLayer ?? []).map(entry => Array.from(entry as ArrayLike<unknown>));
const events = (name: string) => calls().filter(call => call[0] === 'event' && call[1] === name);

beforeEach(() => {
  resetGaForTests();
  consent = { analytics: false, advertising: false };
  appended = [];
  win = { Termly: { getConsentState: () => consent } };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    referrer: 'https://chatgpt.com/c/private-thread',
    createElement: () => ({}),
    head: { appendChild: (node: { src: string }) => appended.push(node) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('GA in the browser', () => {
  it('loads nothing and sends nothing without Termly consent', () => {
    enterPage(`${ORIGIN}/landing`, null);
    syncGa(ID);
    expect(win.dataLayer).toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(win[`ga-disable-${ID}`]).toBe(true);
    expect(sendGaEvent(ID, 'sign_up', { method: 'email' })).toBe(false);
  });

  it('does nothing when no measurement ID is configured', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/landing`, null);
    syncGa(null);
    expect(win.dataLayer).toBeUndefined();
  });

  it('after consent: cleaned global fields before config, no automatic page view, one manual page view', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/positioning/draft-9?utm_source=youtube&email=a@b.c`, null);
    syncGa(ID);
    syncGa(ID);
    const all = calls();
    const set = all.findIndex(call => call[0] === 'set');
    const config = all.findIndex(call => call[0] === 'config');
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(config);
    expect(all[set]![1]).toEqual({
      page_location: `${ORIGIN}/positioning/[draftId]?utm_source=youtube`,
      page_referrer: 'https://chatgpt.com', page_title: '/positioning/[draftId]',
    });
    expect(all[config]).toEqual(['config', ID,
      { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false }]);
    expect(all.find(call => call[0] === 'consent' && call[1] === 'default')?.[2]).toMatchObject({ analytics_storage: 'denied' });
    expect(events('page_view')).toHaveLength(1);
    expect(appended).toEqual([{ async: true, src: `https://www.googletagmanager.com/gtag/js?id=${ID}` }]);
    expect(JSON.stringify(all)).not.toContain('draft-9');
    expect(JSON.stringify(all)).not.toContain('a@b.c');
    expect(JSON.stringify(all)).not.toContain('private-thread');
  });

  it('withdrawal stops every request at once; renewed consent resumes without reload', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/landing`, null);
    syncGa(ID);
    consent.analytics = false;
    syncGa(ID);
    expect(win[`ga-disable-${ID}`]).toBe(true);
    expect(sendGaEvent(ID, 'positioning_complete')).toBe(false);
    enterPage(`${ORIGIN}/faq`, `${ORIGIN}/landing`);
    syncGa(ID);
    expect(events('page_view')).toHaveLength(1);
    consent.analytics = true;
    syncGa(ID);
    expect(win[`ga-disable-${ID}`]).toBe(false);
    expect(events('page_view')).toHaveLength(2);
    expect(sendGaEvent(ID, 'positioning_complete')).toBe(true);
    expect(appended).toHaveLength(1);
  });

  it('pauses GA entirely on pages with one-time keys and resumes after leaving', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/landing`, null);
    syncGa(ID);
    enterPage(`${ORIGIN}/auth/callback?code=one-time`, `${ORIGIN}/landing`);
    syncGa(ID);
    expect(win[`ga-disable-${ID}`]).toBe(true);
    expect(sendGaEvent(ID, 'sign_up', { method: 'email' })).toBe(false);
    enterPage(`${ORIGIN}/positioning`, `${ORIGIN}/auth/callback?code=one-time`);
    syncGa(ID);
    expect(win[`ga-disable-${ID}`]).toBe(false);
    const views = events('page_view');
    expect(views).toHaveLength(2);
    expect(views[1]![2]).toMatchObject({ page_location: `${ORIGIN}/positioning`, page_referrer: ORIGIN });
    expect(JSON.stringify(calls())).not.toContain('one-time');
  });

  it('never loads GA when the first page is sensitive', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/verify-email?email=a@b.c`, null);
    syncGa(ID);
    expect(win.dataLayer).toBeUndefined();
    expect(appended).toHaveLength(0);
  });

  it('key events carry the cleaned page and only the given parameters', () => {
    consent.analytics = true;
    enterPage(`${ORIGIN}/positioning/draft-1`, null);
    syncGa(ID);
    expect(sendGaEvent(ID, 'sign_up', { method: 'google' })).toBe(true);
    expect(events('sign_up')[0]![2]).toEqual({
      method: 'google', page_location: `${ORIGIN}/positioning/[draftId]`, page_title: '/positioning/[draftId]',
    });
  });

  it('grants ad storage only with advertising consent', () => {
    consent = { analytics: true, advertising: false };
    enterPage(`${ORIGIN}/landing`, null);
    syncGa(ID);
    const update = calls().find(call => call[0] === 'consent' && call[1] === 'update');
    expect(update?.[2]).toEqual({ analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  });

  it('reads checkout ids through gtag get only with live consent, in GA format', async () => {
    expect(await readGaCheckoutIds(ID)).toBeNull();
    consent.analytics = true;
    enterPage(`${ORIGIN}/landing/pricing`, null);
    syncGa(ID);
    const answers: Record<string, unknown> = { client_id: '123456789.1700000000', session_id: 1700000000 };
    const gtag = win.gtag as (...args: unknown[]) => void;
    win.gtag = (...args: unknown[]) => {
      if (args[0] === 'get') (args[3] as (value: unknown) => void)(answers[args[2] as string]);
      else gtag(...args);
    };
    expect(await readGaCheckoutIds(ID)).toEqual({ clientId: '123456789.1700000000', sessionId: '1700000000' });
    answers.client_id = 'someone@example.com';
    expect(await readGaCheckoutIds(ID)).toBeNull();
    answers.client_id = '1.2';
    consent.analytics = false;
    expect(await readGaCheckoutIds(ID)).toBeNull();
    consent.analytics = true;
    win.gtag = () => undefined;
    expect(await readGaCheckoutIds(ID, 5)).toBeNull();
  });
});
