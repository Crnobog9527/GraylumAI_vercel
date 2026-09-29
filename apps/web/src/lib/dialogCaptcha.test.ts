import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HCaptchaClient, HCaptchaRenderOptions } from '@/lib/authCaptcha';
import {
  CAPTCHA_REQUIRED_MESSAGE,
  captchaOptionsFromToken,
  loadHCaptcha,
  renderDialogCaptcha,
} from './dialogCaptcha';

function fakeClient() {
  let options: HCaptchaRenderOptions | undefined;
  const client = {
    getResponse: vi.fn(),
    reset: vi.fn(),
    render: vi.fn((_container: HTMLElement, next: HCaptchaRenderOptions) => {
      options = next;
      return 7;
    }),
    remove: vi.fn(),
  } satisfies HCaptchaClient;
  return { client, options: () => options! };
}

function fakeDocument() {
  const listeners: Record<string, Array<() => void>> = {};
  const script = {
    id: '', src: '', async: false,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      (listeners[event] ??= []).push(handler);
    }),
  };
  const byId = new Map<string, typeof script>();
  const doc = {
    getElementById: vi.fn((id: string) => byId.get(id) ?? null),
    createElement: vi.fn(() => script),
    head: { appendChild: vi.fn(() => { byId.set(script.id, script); }) },
  };
  return { doc: doc as unknown as Document, script, fire: (event: string) => listeners[event]?.forEach((handler) => handler()) };
}

describe('captchaOptionsFromToken', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('needs no token when CAPTCHA is not configured', () => {
    expect(captchaOptionsFromToken(null, '')).toEqual({});
  });

  it('fails closed without a token and passes a fresh token through', () => {
    expect(() => captchaOptionsFromToken(null, 'site-key')).toThrow(CAPTCHA_REQUIRED_MESSAGE);
    expect(captchaOptionsFromToken('token-1', 'site-key')).toEqual({ captchaToken: 'token-1' });
  });
});

describe('renderDialogCaptcha', () => {
  it('renders into the given container and reports token, expiry and errors', () => {
    const { client, options } = fakeClient();
    const onToken = vi.fn();
    const onExpired = vi.fn();
    const container = {} as HTMLElement;
    const remove = renderDialogCaptcha(client, container, 'site-key', { onToken, onExpired });

    expect(client.render).toHaveBeenCalledWith(container, expect.objectContaining({ sitekey: 'site-key' }));
    options().callback?.('token-1');
    expect(onToken).toHaveBeenLastCalledWith('token-1');
    options()['expired-callback']?.();
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect(onExpired).toHaveBeenCalledTimes(1);
    options()['error-callback']?.();
    expect(onToken).toHaveBeenLastCalledWith(null);

    remove();
    expect(client.remove).toHaveBeenCalledWith(7);
  });

  it('refuses a client without explicit rendering', () => {
    const client = { getResponse: vi.fn(), reset: vi.fn() };
    expect(() => renderDialogCaptcha(client, {} as HTMLElement, 'k', { onToken: vi.fn(), onExpired: vi.fn() }))
      .toThrow('explicit rendering');
  });
});

describe('loadHCaptcha', () => {
  it('reuses an already loaded client', async () => {
    const { client } = fakeClient();
    const { doc } = fakeDocument();
    await expect(loadHCaptcha({ doc, win: { hcaptcha: client } as unknown as Window })).resolves.toBe(client);
    expect(doc.createElement).not.toHaveBeenCalled();
  });

  it('loads the explicit-render script once and resolves when it is ready', async () => {
    const { client } = fakeClient();
    const { doc, script, fire } = fakeDocument();
    const win = {} as Window;
    const first = loadHCaptcha({ doc, win });
    const second = loadHCaptcha({ doc, win });
    expect(doc.createElement).toHaveBeenCalledTimes(1);
    expect(script.src).toBe('https://js.hcaptcha.com/1/api.js?render=explicit');
    (win as { hcaptcha?: HCaptchaClient }).hcaptcha = client;
    fire('load');
    await expect(first).resolves.toBe(client);
    await expect(second).resolves.toBe(client);
  });

  it('rejects when the script fails to load', async () => {
    const { doc, fire } = fakeDocument();
    const pending = loadHCaptcha({ doc, win: {} as Window });
    fire('error');
    await expect(pending).rejects.toThrow('hCaptcha unavailable');
  });
});
