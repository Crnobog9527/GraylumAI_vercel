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

type FakeScript = {
  id: string; src: string; async: boolean;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (event: string, handler: () => void) => void;
  remove: () => void;
};

function fakeDocument() {
  const byId = new Map<string, FakeScript>();
  const scripts: FakeScript[] = [];
  const createElement = vi.fn(() => {
    const script: FakeScript = {
      id: '', src: '', async: false, listeners: {},
      addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); },
      remove() { if (byId.get(this.id) === this) byId.delete(this.id); },
    };
    scripts.push(script);
    return script;
  });
  const doc = {
    getElementById: vi.fn((id: string) => byId.get(id) ?? null),
    createElement,
    head: { appendChild: vi.fn((script: FakeScript) => { byId.set(script.id, script); }) },
  };
  const latest = () => scripts[scripts.length - 1];
  return {
    doc: doc as unknown as Document,
    get script() { return latest(); },
    fire: (event: string) => latest().listeners[event]?.forEach((handler) => handler()),
    attached: () => byId.size,
  };
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
    const fake = fakeDocument();
    const win = {} as Window;
    const first = loadHCaptcha({ doc: fake.doc, win });
    const second = loadHCaptcha({ doc: fake.doc, win });
    expect(fake.doc.createElement).toHaveBeenCalledTimes(1);
    expect(fake.script.src).toBe('https://js.hcaptcha.com/1/api.js?render=explicit');
    (win as { hcaptcha?: HCaptchaClient }).hcaptcha = client;
    fake.fire('load');
    await expect(first).resolves.toBe(client);
    await expect(second).resolves.toBe(client);
  });

  it('rejects when the script fails to load and loads afresh on the next call', async () => {
    const fake = fakeDocument();
    const win = {} as Window;
    const first = loadHCaptcha({ doc: fake.doc, win });
    fake.fire('error');
    await expect(first).rejects.toThrow('hCaptcha unavailable');
    expect(fake.attached()).toBe(0);

    const { client } = fakeClient();
    const second = loadHCaptcha({ doc: fake.doc, win });
    expect(fake.doc.createElement).toHaveBeenCalledTimes(2);
    (win as { hcaptcha?: HCaptchaClient }).hcaptcha = client;
    fake.fire('load');
    await expect(second).resolves.toBe(client);
  });

  it('settles every caller of a failed load and removes a script that loads without a client', async () => {
    const fake = fakeDocument();
    const win = {} as Window;
    const a = loadHCaptcha({ doc: fake.doc, win });
    const b = loadHCaptcha({ doc: fake.doc, win });
    fake.fire('load');
    await expect(a).rejects.toThrow('hCaptcha unavailable');
    await expect(b).rejects.toThrow('hCaptcha unavailable');
    expect(fake.attached()).toBe(0);
  });
});
