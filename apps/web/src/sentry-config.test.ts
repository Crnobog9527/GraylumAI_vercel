import { afterEach, describe, expect, it, vi } from 'vitest';

const { init, replayIntegration } = vi.hoisted(() => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
}));
vi.mock('@sentry/nextjs', () => ({
  init,
  replayIntegration,
  httpIntegration: vi.fn(() => ({ name: 'Http' })),
  captureRouterTransitionStart: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Sentry runtime sampling and replay privacy', () => {
  it.each(['production', 'development'])('keeps all runtimes consistent in %s', async environment => {
    vi.stubEnv('NODE_ENV', environment);
    await import('../sentry.server.config');
    await import('../sentry.edge.config');
    await import('./instrumentation-client');
    expect(init).toHaveBeenCalledTimes(3);
    for (const [options] of init.mock.calls) {
      expect(options.tracesSampleRate).toBe(environment === 'production' ? 0.1 : 0);
    }
    // DATA-ERASURE E7: Replay metadata carries full page URLs, so it stays off in every runtime.
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(init.mock.calls[2][0]).toMatchObject({ replaysOnErrorSampleRate: 0, replaysSessionSampleRate: 0 });
    for (const [options] of init.mock.calls) {
      expect(options).toMatchObject({ sendDefaultPii: false });
      expect(typeof options.beforeSend).toBe('function');
      expect(typeof options.beforeSendTransaction).toBe('function');
      expect(typeof options.beforeBreadcrumb).toBe('function');
    }
  });
});
