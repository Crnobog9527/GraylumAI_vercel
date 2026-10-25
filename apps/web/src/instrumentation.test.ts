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
    validateEnvOnStartup.mockReturnValue({ valid: false, errors: ['CRON_SECRET: missing'], warnings: [], environment: 'production' });
    const { register } = await import('./instrumentation');
    await expect(register()).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalledWith('env_validation_failed', expect.objectContaining({ level: 'error' }));
  });

  it('stays quiet when validation passes', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    validateEnvOnStartup.mockReturnValue({ valid: true, errors: [], warnings: [], environment: 'production' });
    const { register } = await import('./instrumentation');
    await register();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
