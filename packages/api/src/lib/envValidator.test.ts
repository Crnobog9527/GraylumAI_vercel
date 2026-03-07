import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEnv } from './envValidator';

const ORIGINAL_ENV = { ...process.env };

function applyBaseEnv(): void {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'development',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(100),
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
});
