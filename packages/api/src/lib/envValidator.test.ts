import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEnv } from './envValidator';

const ORIGINAL_ENV = { ...process.env };

function applyBaseEnv(): void {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'development',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(100),
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    NEXT_PUBLIC_SITE_NAME: 'ExampleAI',
    NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.com',
    OPENROUTER_API_KEY: `sk-or-${'a'.repeat(32)}`,
    DATABASE_URL: 'postgresql://postgres:password@example.supabase.co:6543/postgres',
    SENTRY_AUTH_TOKEN: `sntrys_${'a'.repeat(32)}`,
  };
}

describe('validateEnv', () => {
  beforeEach(() => {
    applyBaseEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('accepts correctly formatted DATABASE_URL and SENTRY_AUTH_TOKEN values', () => {
    const result = validateEnv();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects DATABASE_URL values polluted with a duplicated key prefix', () => {
    process.env.DATABASE_URL = 'DATABASE_URL=postgresql://postgres:password@example.supabase.co:6543/postgres';

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'DATABASE_URL: DATABASE_URL 的值包含重复的 DATABASE_URL= 前缀，请修正环境变量来源'
    );
  });

  it('rejects SENTRY_AUTH_TOKEN values polluted with a duplicated key prefix', () => {
    process.env.SENTRY_AUTH_TOKEN = `SENTRY_AUTH_TOKEN=sntrys_${'a'.repeat(32)}`;

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'SENTRY_AUTH_TOKEN: SENTRY_AUTH_TOKEN 的值包含重复的 SENTRY_AUTH_TOKEN= 前缀，请修正环境变量来源'
    );
  });

  it('requires NEXT_PUBLIC_APP_URL in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXT_PUBLIC_APP_URL;

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('生产环境必须配置 NEXT_PUBLIC_APP_URL');
  });

  it('rejects localhost NEXT_PUBLIC_APP_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('生产环境不能使用 localhost NEXT_PUBLIC_APP_URL');
  });

  it('requires NEXT_PUBLIC_APP_URL when Stripe is partially configured', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_1234567890';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_1234567890';

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('启用 Stripe 时必须配置 NEXT_PUBLIC_APP_URL');
  });

  it('requires SUPABASE_SERVICE_ROLE_KEY when Stripe is enabled', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_1234567890';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_1234567890';

    const result = validateEnv();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('启用 Stripe 时必须配置 SUPABASE_SERVICE_ROLE_KEY');
  });
});
