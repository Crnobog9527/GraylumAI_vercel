import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn<(...args: unknown[]) => boolean>(() => true);
vi.mock('./ga', () => ({ sendGaEvent: (...args: unknown[]) => send(...args) }));
vi.mock('./config', () => ({ ANALYTICS_CONFIG: { gaMeasurementId: 'G-TEST123' } }));

const { reportSignUpIfNew } = await import('./events');

const NOW = Date.parse('2026-10-17T10:00:00Z');
let store: Record<string, string>;
beforeEach(() => {
  send.mockClear();
  send.mockReturnValue(true);
  store = {};
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => store[key] ?? null, setItem: (key: string, value: string) => { store[key] = value; },
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('reportSignUpIfNew', () => {
  const fresh = { created_at: '2026-10-17T09:50:00Z', app_metadata: { provider: 'google' } };

  it('sends sign_up once for a new verified account, with the method only', () => {
    expect(reportSignUpIfNew(fresh, true, NOW)).toBe(true);
    expect(send).toHaveBeenCalledWith('G-TEST123', 'sign_up', { method: 'google' });
    expect(reportSignUpIfNew(fresh, true, NOW)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips old, unverified or missing accounts', () => {
    expect(reportSignUpIfNew({ created_at: '2026-10-17T09:00:00Z', app_metadata: { provider: 'google' } }, true, NOW)).toBe(false);
    expect(reportSignUpIfNew({ created_at: '2026-10-17T09:55:00Z', email_confirmed_at: '2026-10-17T09:00:00Z' }, true, NOW)).toBe(false);
    expect(reportSignUpIfNew({ created_at: '2026-10-17T09:55:00Z' }, true, NOW)).toBe(false);
    expect(reportSignUpIfNew({ ...fresh, app_metadata: {} }, false, NOW)).toBe(false);
    expect(reportSignUpIfNew(null, true, NOW)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not remember an event GA refused (no consent), so it can be sent after consent', () => {
    send.mockReturnValue(false);
    // An email account registered yesterday whose link was opened just now still counts.
    const email = { created_at: '2026-10-16T09:00:00Z', email_confirmed_at: '2026-10-17T09:58:00Z' };
    expect(reportSignUpIfNew(email, true, NOW)).toBe(false);
    expect(store).toEqual({});
    send.mockReturnValue(true);
    expect(reportSignUpIfNew(email, true, NOW)).toBe(true);
    expect(send).toHaveBeenLastCalledWith('G-TEST123', 'sign_up', { method: 'email' });
  });
});
