import { describe, expect, it, vi } from 'vitest';
import type { HCaptchaClient } from '@/lib/authCaptcha';
import { CAPTCHA_FAILED_MESSAGE, CAPTCHA_UNAVAILABLE_MESSAGE, invisibleCaptchaOptions } from './invisibleCaptcha';

type Holder = { attrs: Record<string, string>; removed: boolean; setAttribute: (k: string, v: string) => void; remove: () => void };

function fakeEnv(execute: HCaptchaClient['execute'] | undefined) {
  const holders: Holder[] = [];
  const attached: Holder[] = [];
  const listeners: string[] = [];
  let nextId = 1;
  const client = {
    getResponse: vi.fn(), reset: vi.fn(),
    render: vi.fn(() => nextId++),
    remove: vi.fn(),
    execute,
  };
  const doc = {
    createElement: vi.fn(() => {
      const holder: Holder = {
        attrs: {}, removed: false,
        setAttribute(k, v) { this.attrs[k] = v; },
        remove() { this.removed = true; attached.splice(attached.indexOf(this), 1); },
      };
      holders.push(holder);
      return holder;
    }),
    body: { appendChild: vi.fn((holder: Holder) => { attached.push(holder); }) },
    getElementById: vi.fn(() => null),
  };
  const win = {
    hcaptcha: client,
    addEventListener: vi.fn((type: string) => { listeners.push(type); }),
    removeEventListener: vi.fn((type: string) => { listeners.splice(listeners.indexOf(type), 1); }),
  };
  const env = { doc: doc as unknown as Document, win: win as unknown as Window };
  return { env, client, holders, attached, listeners };
}

describe('invisibleCaptchaOptions', () => {
  it('needs nothing when CAPTCHA is not configured', async () => {
    const { env, client } = fakeEnv(vi.fn());
    await expect(invisibleCaptchaOptions(env, '')).resolves.toEqual({});
    expect(client.render).not.toHaveBeenCalled();
  });

  it('renders an invisible widget, executes it once, and cleans everything up', async () => {
    let listenersDuringExecute: string[] = [];
    const fake = fakeEnv(vi.fn(async () => {
      listenersDuringExecute = [...fake.listeners];
      return { response: 'token-1', key: 'k' };
    }));
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).resolves.toEqual({ captchaToken: 'token-1' });
    expect(fake.client.render).toHaveBeenCalledWith(fake.holders[0], { sitekey: 'site-key', size: 'invisible' });
    expect(fake.client.execute).toHaveBeenCalledWith(1, { async: true });
    // The focus guard for a possible challenge is active only while executing.
    expect(listenersDuringExecute.sort()).toEqual(['focusin', 'focusout']);
    expect(fake.listeners).toEqual([]);
    expect(fake.client.remove).toHaveBeenCalledWith(1);
    expect(fake.holders[0].removed).toBe(true);
    expect(fake.attached).toEqual([]);
  });

  it('uses a fresh widget per attempt so every token is single use', async () => {
    const fake = fakeEnv(vi.fn()
      .mockResolvedValueOnce({ response: 'token-1' })
      .mockResolvedValueOnce({ response: 'token-2' }));
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).resolves.toEqual({ captchaToken: 'token-1' });
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).resolves.toEqual({ captchaToken: 'token-2' });
    expect(fake.client.render).toHaveBeenCalledTimes(2);
    expect(fake.client.remove.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    ['challenge-closed', '人机验证已取消，请重试。'],
    ['challenge-expired', '人机验证已超时，请重试。'],
    ['rate-limited', '操作太频繁，请稍后再试。'],
    ['network-error', '网络异常，人机验证未完成，请重试。'],
    ['invalid-captcha-id', CAPTCHA_FAILED_MESSAGE],
  ])('turns %s into a retryable message and still cleans up', async (code, message) => {
    const fake = fakeEnv(vi.fn(async () => { throw code; }));
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).rejects.toThrow(message);
    expect(fake.listeners).toEqual([]);
    expect(fake.client.remove).toHaveBeenCalledWith(1);
    expect(fake.attached).toEqual([]);
  });

  it('rejects an empty response', async () => {
    const fake = fakeEnv(vi.fn(async () => ({ response: '' })));
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).rejects.toThrow(CAPTCHA_FAILED_MESSAGE);
  });

  it('reports unavailable when the loaded client cannot execute', async () => {
    const fake = fakeEnv(undefined);
    await expect(invisibleCaptchaOptions(fake.env, 'site-key')).rejects.toThrow(CAPTCHA_UNAVAILABLE_MESSAGE);
    expect(fake.client.render).not.toHaveBeenCalled();
    expect(fake.attached).toEqual([]);
  });
});
