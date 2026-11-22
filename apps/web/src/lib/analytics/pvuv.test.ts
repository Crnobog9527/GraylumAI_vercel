import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identifyPvuv, installPvuvScrubber, resetPvuvForTests, syncPvuv } from './pvuv';

const consent = vi.hoisted(() => ({ analytics: false }));
vi.mock('./consent', () => ({ analyticsAllowed: () => consent.analytics }));

const ORIGIN = 'https://www.graylum.com';
type Script = { src?: string; attrs: Record<string, string>; setAttribute: (k: string, v: string) => void; onload?: () => void };
type FetchFn = (url: string, init?: object) => Promise<unknown>;

let win: Record<string, unknown>;
let appended: Script[];
let sent: { url: string; body: unknown }[];
let beacons: { url: string; body: unknown }[];

function makeScript(): Script {
  const script: Script = { attrs: {}, setAttribute: (k, v) => { script.attrs[k] = v; } };
  return script;
}

beforeEach(() => {
  resetPvuvForTests();
  consent.analytics = false;
  appended = [];
  sent = [];
  beacons = [];
  win = {
    location: { pathname: '/pricing', hostname: 'www.graylum.com', origin: ORIGIN, protocol: 'https:', href: `${ORIGIN}/pricing` },
    localStorage: {},
    fetch: (url: string, init?: { body?: unknown }) => { sent.push({ url, body: init?.body }); return Promise.resolve(new Response('{}')); },
    requestIdleCallback: (cb: () => void) => cb(),
    addEventListener: vi.fn(),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { readyState: 'complete', cookie: '', createElement: makeScript, head: { appendChild: (n: Script) => appended.push(n) } });
  vi.stubGlobal('navigator', { sendBeacon: (url: string, body: unknown) => { beacons.push({ url, body }); return true; } });
});
afterEach(() => vi.unstubAllGlobals());

describe('pvuv script loading', () => {
  it('adds no script and no queue without consent', () => {
    syncPvuv('site_abc', '/pricing');
    expect(appended).toHaveLength(0);
    expect(win.pvuv).toBeUndefined();
  });

  it('adds no script when no site id is configured', () => {
    consent.analytics = true;
    syncPvuv(null, '/pricing');
    expect(appended).toHaveLength(0);
  });

  it('loads the script once on a public page after consent, with the site id and an exclude list', () => {
    consent.analytics = true;
    syncPvuv('site_abc', '/pricing');
    syncPvuv('site_abc', '/pricing');
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe('https://www.pvuv.ai/f.js');
    expect(appended[0].attrs['data-site']).toBe('site_abc');
    expect(appended[0].attrs['data-exclude']).toContain('/app/*');
  });

  it.each(['/app', '/app/positioning/abc', '/admin/users', '/auth/callback', '/checkout/x', '/reset-password'])(
    'never loads the script on the sensitive or logged-in page %s',
    path => {
      consent.analytics = true;
      (win.location as { pathname: string }).pathname = path;
      syncPvuv('site_abc', path);
      expect(appended).toHaveLength(0);
    },
  );

  it('waits for the load event when the page is still loading', () => {
    consent.analytics = true;
    (document as unknown as { readyState: string }).readyState = 'loading';
    syncPvuv('site_abc', '/pricing');
    expect(appended).toHaveLength(0);
    const [event, start] = (win.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(event).toBe('load');
    start();
    expect(appended).toHaveLength(1);
  });

  it('does not insert if consent was withdrawn while waiting for idle time', () => {
    consent.analytics = true;
    win.requestIdleCallback = (cb: () => void) => { consent.analytics = false; cb(); };
    syncPvuv('site_abc', '/pricing');
    expect(appended).toHaveLength(0);
  });

  it('reloads the page after a refusal once the script is running, and not before', () => {
    const reload = vi.fn();
    syncPvuv('site_abc', '/pricing', reload);
    expect(reload).not.toHaveBeenCalled();
    consent.analytics = true;
    syncPvuv('site_abc', '/pricing', reload);
    consent.analytics = false;
    syncPvuv('site_abc', '/pricing', reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('pvuv identify', () => {
  it('queues the account id and hands it to the script, only with consent', () => {
    identifyPvuv('user-1');
    consent.analytics = true;
    identifyPvuv('user-1');
    syncPvuv('site_abc', '/pricing');
    expect((win.pvuv as unknown as { q: unknown[][] }).q).toEqual([['identify', 'user-1']]);
  });

  it('sends nothing without consent', () => {
    identifyPvuv('user-1');
    syncPvuv('site_abc', '/pricing');
    expect(win.pvuv).toBeUndefined();
  });
});

describe('pvuv request scrubber', () => {
  const event = JSON.stringify({ e: 'pageview', u: `${ORIGIN}/pricing?utm_source=a&secret=1#x`, r: 'https://x.com/a?b=1' });

  it('cleans what goes to pvuv.ai and leaves other requests alone', async () => {
    consent.analytics = true;
    installPvuvScrubber();
    await (win.fetch as FetchFn)('https://in.pvuv.ai/in', { method: 'POST', body: event });
    await (win.fetch as FetchFn)('https://other.example/x', { method: 'POST', body: event });
    expect(JSON.parse(sent[0].body as string)).toEqual({ e: 'pageview', u: `${ORIGIN}/pricing?utm_source=a`, r: 'https://x.com' });
    expect(sent[1].body).toBe(event);
    navigator.sendBeacon('https://in.pvuv.ai/in', event);
    expect(JSON.parse(beacons[0].body as string).u).toBe(`${ORIGIN}/pricing?utm_source=a`);
  });

  it('sends nothing to pvuv.ai after consent is refused', async () => {
    consent.analytics = true;
    installPvuvScrubber();
    consent.analytics = false;
    await (win.fetch as FetchFn)('https://in.pvuv.ai/in', { method: 'POST', body: event });
    navigator.sendBeacon('https://in.pvuv.ai/in', event);
    expect(sent).toHaveLength(0);
    expect(beacons).toHaveLength(0);
  });

  it('drops an event for a private page even with consent', () => {
    consent.analytics = true;
    installPvuvScrubber();
    navigator.sendBeacon('https://in.pvuv.ai/in', JSON.stringify({ e: 'pageview', u: `${ORIGIN}/app/positioning/abc` }));
    expect(beacons).toHaveLength(0);
  });
});
