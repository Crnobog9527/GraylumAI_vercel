/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { LIVE_PAYMENT_PIPELINE_READY, assertMethodCheckoutEnvironment, methodCardCheckoutReady, methodCheckoutEnvironmentOpen } from './methodCheckoutGate';

// The staging deployment, bound like the runtime staging check (project, branch, repository, database).
const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic-staging-project',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic-staging-project', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001' };
const routes = (card: boolean) => ({ version: 4, card: { enabled: card }, card_cn: { enabled: card },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });
const methods = ['card', 'card_cn', 'wechat_pay', 'alipay'] as const;

describe('PAY-STRIPE-MP checkout gate (3c: card open on staging only, behind the server switch)', () => {
  it('production stays closed whatever its configuration', () => {
    for (const host of ['app.graylum.com', 'graylum.com', 'www.graylum.com', 'evil-auth-staging.graylum.com', '']) {
      const env = { ...staging, VERCEL_PROJECT_PRODUCTION_URL: host, VERCEL_ENV: 'production' };
      for (const method of methods) {
        expect(methodCheckoutEnvironmentOpen(env, method)).toBe(false);
        expect(() => assertMethodCheckoutEnvironment(env, method)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
      }
      expect(methodCardCheckoutReady(env, routes(true))).toBe(false);
    }
  });
  it('staging opens card checkout in code; the default-off server switch still decides; wallets stay closed', () => {
    // 3c "打开银行卡下单": the code gate is open on staging only. The old Waffo test flag changes nothing.
    for (const env of [staging, { ...staging, WAFFO_TEST_OPERATIONS_ENABLED: 'true' }]) {
      for (const method of ['card', 'card_cn'] as const) {
        expect(methodCheckoutEnvironmentOpen(env, method)).toBe(true);
        expect(() => assertMethodCheckoutEnvironment(env, method)).not.toThrow();
      }
      for (const method of ['wechat_pay', 'alipay'] as const) {
        expect(methodCheckoutEnvironmentOpen(env, method)).toBe(false);
      }
      expect(methodCardCheckoutReady(env, routes(true))).toBe(true);
      expect(methodCardCheckoutReady(env, routes(false))).toBe(false);
    }
    expect(methodCardCheckoutReady(staging, null)).toBe(false);
    // Either card route makes the entry ready; `routes` tells the page which method is open.
    expect(methodCardCheckoutReady(staging, { ...routes(false), card_cn: { enabled: true } })).toBe(true);
  });
  it('a preview of the staging project, another project or another database stays closed', () => {
    for (const patch of [{ VERCEL_GIT_COMMIT_REF: 'feature-branch', VERCEL_ENV: 'preview' }, { VERCEL_PROJECT_ID: 'other-project' },
      { NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co' }, { VERCEL_GIT_REPO_OWNER: 'someone-else' },
      { VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' }, { VERCEL: undefined }]) {
      expect(methodCheckoutEnvironmentOpen({ ...staging, ...patch }, 'card')).toBe(false);
      expect(methodCardCheckoutReady({ ...staging, ...patch }, routes(true))).toBe(false);
    }
  });
});

// R7: the production deployment, bound like RUNTIME-PROD (R5): project, `main`, repository, exact domain, database host.
const production = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'synthetic-production-project', V3_RUNTIME_PRODUCTION_PROJECT_ID: 'synthetic-production-project',
  NEXT_PUBLIC_SUPABASE_URL: 'https://prodsynthetic.supabase.co', V3_RUNTIME_PRODUCTION_DATABASE_HOST: 'prodsynthetic.supabase.co' };
const cardOn = { PAY_PRODUCTION_CARD_CHECKOUT_ENABLED: 'true' };
const walletOn = { PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED: 'true' };
// The binding and switch logic is tested with the live pipeline marked ready; the real constant is tested below.
const open = (env: Record<string, string | undefined>) => methods.filter(method => methodCheckoutEnvironmentOpen(env, method, true));

describe('R7 production checkout gate: bound deployment plus a separate default-off switch per kind', () => {
  it('stays closed on the bound production deployment until a switch is set', () => {
    expect(open(production)).toEqual([]);
    for (const value of ['1', 'TRUE', 'yes', ' true', '']) {
      expect(open({ ...production, PAY_PRODUCTION_CARD_CHECKOUT_ENABLED: value,
        PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED: value })).toEqual([]);
    }
    expect(methodCardCheckoutReady(production, routes(true), true)).toBe(false);
  });
  it('opens card and wallets independently on the bound production deployment', () => {
    expect(open({ ...production, ...cardOn })).toEqual(['card', 'card_cn']);
    expect(open({ ...production, ...walletOn })).toEqual(['wechat_pay', 'alipay']);
    expect(open({ ...production, ...cardOn, ...walletOn })).toEqual(methods);
    expect(open({ ...production, ...cardOn, VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' })).toEqual(['card', 'card_cn']);
    expect(() => assertMethodCheckoutEnvironment({ ...production, ...cardOn }, 'card', true)).not.toThrow();
    expect(() => assertMethodCheckoutEnvironment({ ...production, ...cardOn }, 'alipay', true)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
    // The member page still needs the default-off route switch on top of the code gate.
    expect(methodCardCheckoutReady({ ...production, ...cardOn }, routes(true), true)).toBe(true);
    expect(methodCardCheckoutReady({ ...production, ...cardOn }, routes(false), true)).toBe(false);
    expect(methodCardCheckoutReady({ ...production, ...walletOn }, routes(true), true)).toBe(false);
  });
  it.each(Object.keys(production))('stays closed with both switches on when %s is missing', key =>
    expect(open({ ...production, ...cardOn, ...walletOn, [key]: undefined })).toEqual([]));
  it.each([
    { VERCEL_GIT_COMMIT_REF: 'staging' }, { VERCEL_GIT_COMMIT_REF: 'feature' }, { VERCEL_ENV: 'preview' }, { VERCEL: '0' },
    { VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com' }, { VERCEL_PROJECT_PRODUCTION_URL: 'graylum.com' },
    { VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com.evil.invalid' }, { VERCEL_PROJECT_PRODUCTION_URL: 'APP.GRAYLUM.COM' },
    { VERCEL_PROJECT_PRODUCTION_URL: 'graylum-ai-vercel-v1.vercel.app' },
    { VERCEL_GIT_REPO_OWNER: 'someone-else' }, { VERCEL_GIT_REPO_SLUG: 'fork' }, { VERCEL_PROJECT_ID: 'staging-project' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co' }, { NEXT_PUBLIC_SUPABASE_URL: 'http://prodsynthetic.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://user:secret@prodsynthetic.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://prodsynthetic.supabase.co:8443' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://prodsynthetic.supabase.co/path' }, { NEXT_PUBLIC_SUPABASE_URL: 'not a url' },
    { V3_RUNTIME_PRODUCTION_DATABASE_HOST: 'other.supabase.co' },
  ])('stays closed with both switches on for a mismatched target %#', patch =>
    expect(open({ ...production, ...cardOn, ...walletOn, ...patch })).toEqual([]));
  it.each(['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID', 'V3_RUNTIME_STAGING_DATABASE_HOST',
    'V3_RUNTIME_STAGING_WINDOW_ID'])('refuses a mixed configuration with %s set', key =>
    expect(open({ ...production, ...cardOn, ...walletOn, [key]: 'x' })).toEqual([]));
  it('the production switches change nothing on staging or on any other deployment', () => {
    expect(open({ ...staging, ...cardOn, ...walletOn })).toEqual(['card', 'card_cn']);
    expect(open({ ...staging, PAY_PRODUCTION_CARD_CHECKOUT_ENABLED: 'false' })).toEqual(['card', 'card_cn']);
    expect(open({ ...cardOn, ...walletOn })).toEqual([]);
    // Production project variables on the staging deployment do not turn it into production.
    expect(open({ ...staging, ...walletOn, V3_RUNTIME_PRODUCTION_PROJECT_ID: staging.VERCEL_PROJECT_ID,
      V3_RUNTIME_PRODUCTION_DATABASE_HOST: staging.V3_RUNTIME_STAGING_DATABASE_HOST })).toEqual(['card', 'card_cn']);
  });
});

describe('R7 hard guard: the live payment pipeline is wired (PR-B1/B2/B3), so the marker is on', () => {
  it('the marker is on', () => expect(LIVE_PAYMENT_PIPELINE_READY).toBe(true));
  it('a fully bound production deployment with both switches true opens by default; the marker off still refuses', () => {
    const env = { ...production, ...cardOn, ...walletOn };
    for (const method of methods) {
      expect(methodCheckoutEnvironmentOpen(env, method)).toBe(true);
      expect(() => assertMethodCheckoutEnvironment(env, method)).not.toThrow();
      expect(methodCheckoutEnvironmentOpen(env, method, false)).toBe(false);
      expect(() => assertMethodCheckoutEnvironment(env, method, false)).toThrow('PAY_WAFFO_STEP2_NOT_READY');
    }
    expect(methodCardCheckoutReady(env, routes(true))).toBe(true);
    expect(methodCardCheckoutReady(env, routes(true), false)).toBe(false);
  });
  it('staging is not affected by the marker', () => {
    expect(methodCheckoutEnvironmentOpen(staging, 'card')).toBe(true);
    expect(methodCheckoutEnvironmentOpen(staging, 'card', false)).toBe(true);
    expect(methodCardCheckoutReady(staging, routes(true))).toBe(true);
  });
});
