/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it } from 'vitest';
import { resetPlatformSecretCacheForTests } from '../platformSecrets/reader';
import { DEFAULT_NOTICE_FROM, isProductionSite, noticeConfig } from './config';

const db = (value: string | null, error: unknown = null) => ({ rpc: () => ({ abortSignal: async () => ({ data: value, error }) }) });
beforeEach(() => resetPlatformSecretCacheForTests());

it('only the approved production project is unrestricted; anything unknown fails closed', () => {
  const prod = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' };
  expect(isProductionSite(prod)).toBe(true);
  expect(isProductionSite({ ...prod, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' })).toBe(true);
  expect(isProductionSite({ ...prod, VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com' })).toBe(false);
  expect(isProductionSite({ ...prod, VERCEL_PROJECT_PRODUCTION_URL: 'new-staging.graylum.com' })).toBe(false);
  expect(isProductionSite({ ...prod, VERCEL_PROJECT_PRODUCTION_URL: undefined })).toBe(false);
  expect(isProductionSite({ ...prod, VERCEL_GIT_COMMIT_REF: 'staging' })).toBe(false);
  expect(isProductionSite({ ...prod, VERCEL_ENV: 'preview' })).toBe(false);
  expect(isProductionSite({ ...prod, VERCEL: undefined })).toBe(false);
  expect(isProductionSite({})).toBe(false);
});

it('without the admin key nothing is configured; Vercel variables are never used', async () => {
  expect(await noticeConfig(db(null) as never, { RESEND_API_KEY: 're_from_env_0000' }))
    .toEqual({ ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' });
});

it('a failed key read is an error, not "not configured"', async () => {
  await expect(noticeConfig(db(null, { code: 'XX000' }) as never, {})).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
});

it('outside production only the test list may receive mail, and an empty list sends nothing', async () => {
  expect(await noticeConfig(db('re_fake_key_1234') as never, {})).toEqual({ ok: false, code: 'PAYMENT_NOTICE_TEST_RECIPIENTS_MISSING' });
  const result = await noticeConfig(db('re_fake_key_1234') as never,
    { PAYMENT_NOTICE_TEST_RECIPIENTS: ' A@Example.test , not-an-address ,b@example.test', PAYMENT_NOTICE_REPLY_TO: 'help@example.test' });
  expect(result).toEqual({ ok: true, config: { apiKey: 're_fake_key_1234', from: DEFAULT_NOTICE_FROM,
    replyTo: 'help@example.test', allowedRecipients: new Set(['a@example.test', 'b@example.test']) } });
});

it('production mails any user', async () => {
  const result = await noticeConfig(db('re_fake_key_1234') as never, { VERCEL: '1', VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main', VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com', PAYMENT_NOTICE_FROM: 'Graylum <notice@graylum.com>' });
  expect(result).toMatchObject({ ok: true, config: { allowedRecipients: null, from: 'Graylum <notice@graylum.com>', replyTo: null } });
});
