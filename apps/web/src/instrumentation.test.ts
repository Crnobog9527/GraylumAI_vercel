import { scrubErrorEvent } from './lib/sentry-scrub';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureMessage, validateEnvOnStartup } = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  validateEnvOnStartup: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage, captureRequestError: vi.fn() }));
vi.mock('../sentry.server.config', () => ({}));
vi.mock('@repo/api/src/lib/envValidator', () => ({ validateEnvOnStartup }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('instrumentation env validation', () => {
  it('reports a failed validation to Sentry without throwing', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    validateEnvOnStartup.mockReturnValue({ valid: false, errors: ['CRON_SECRET: missing', '生产环境必须配置 NEXT_PUBLIC_APP_URL'],
      warnings: [], environment: 'production' });
    const { register } = await import('./instrumentation');
    await expect(register()).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0]!;
    expect(message).toBe('ENV_VALIDATION_FAILED');
    // What Sentry keeps after the real scrubber: the fixed code and the variable names, nothing else.
    const kept = scrubErrorEvent({ message, level: options.level, extra: { ...options.extra, note: 'secret text' } } as never);
    expect(kept.message).toBe('ENV_VALIDATION_FAILED');
    expect(kept.extra).toEqual({ variables: ['CRON_SECRET', 'NEXT_PUBLIC_APP_URL'] });
  });

  it('stays quiet when validation passes', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    validateEnvOnStartup.mockReturnValue({ valid: true, errors: [], warnings: [], environment: 'production' });
    const { register } = await import('./instrumentation');
    await register();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
