/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { registerSignup, signUpAfterRegistration, SIGNUP_REQUEST_MESSAGES, SIGNUP_REQUEST_PATH } from './signupRequest';

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('registerSignup', () => {
  it('posts the address as JSON to our route and resolves null when registered', async () => {
    const doFetch = answer(200, { ok: true });
    expect(await registerSignup('a@example.com', doFetch as unknown as typeof fetch)).toBeNull();
    expect(doFetch).toHaveBeenCalledWith(SIGNUP_REQUEST_PATH, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'a@example.com' }),
    }));
  });

  it('shows the line for each refusal; the hourly one says an hour, not a minute', async () => {
    for (const code of Object.keys(SIGNUP_REQUEST_MESSAGES) as (keyof typeof SIGNUP_REQUEST_MESSAGES)[]) {
      expect(await registerSignup('a@example.com', answer(429, { ok: false, code }) as unknown as typeof fetch))
        .toBe(SIGNUP_REQUEST_MESSAGES[code]);
    }
    expect(SIGNUP_REQUEST_MESSAGES.SIGNUP_TOO_MANY_HOURLY).toContain('一小时');
  });

  it('never lets an unknown answer or a network failure through as registered', async () => {
    expect(await registerSignup('a@example.com', answer(429, 'blocked') as unknown as typeof fetch))
      .toBe(SIGNUP_REQUEST_MESSAGES.SIGNUP_TOO_MANY_HOURLY);
    expect(await registerSignup('a@example.com', answer(200, { ok: false }) as unknown as typeof fetch))
      .toBe(SIGNUP_REQUEST_MESSAGES.SIGNUP_UNAVAILABLE);
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await registerSignup('a@example.com', offline as unknown as typeof fetch)).toBe(SIGNUP_REQUEST_MESSAGES.SIGNUP_UNAVAILABLE);
  });
});

describe('signUpAfterRegistration', () => {
  it('registers the trimmed address first, then signs up with the same address', async () => {
    const order: string[] = [];
    const register = vi.fn(async (email: string) => { order.push(`register ${email}`); return null; });
    const signUp = vi.fn(async (email: string) => { order.push(`signUp ${email}`); return 'done'; });
    expect(await signUpAfterRegistration(' a@example.com ', signUp, register)).toEqual({ result: 'done' });
    expect(order).toEqual(['register a@example.com', 'signUp a@example.com']);
  });

  it('never calls Supabase when registration refused', async () => {
    const signUp = vi.fn(async () => 'done');
    expect(await signUpAfterRegistration('a@example.com', signUp, async () => SIGNUP_REQUEST_MESSAGES.SIGNUP_TOO_MANY_DAILY))
      .toEqual({ refused: SIGNUP_REQUEST_MESSAGES.SIGNUP_TOO_MANY_DAILY });
    expect(signUp).not.toHaveBeenCalled();
  });
});
