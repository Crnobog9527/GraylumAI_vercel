/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { assertMethodCheckoutEnvironment, methodCardCheckoutReady, methodCheckoutEnvironmentOpen } from './methodCheckoutGate';

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
