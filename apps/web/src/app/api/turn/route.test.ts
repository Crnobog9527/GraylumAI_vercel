import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ handle: vi.fn<(request: unknown, deps: unknown) => Promise<Response>>(async () => new Response('ok')) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ client: 'stub' }) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ client: 'stub' }) }));
vi.mock('@repo/api/src/services/turn/http', () => ({ handleTurnRequest: mocks.handle }));
vi.mock('@repo/api/src/services/turn/limiter', () => ({ redisCounterStore: () => ({}) }));
vi.mock('@repo/api/src/services/redisRateLimiter', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@repo/api/src/services/platformSecrets/request', () => ({ withPlatformSecretRequest: (run: () => unknown) => run() }));
vi.mock('@repo/api/src/services/runtime/catalogCache', () => ({ withCatalogRequest: (run: () => unknown) => run() }));
vi.mock('@repo/api/src/services/runtime/newWorkGate', () => ({ newWorkGate: () => ({}) }));
vi.mock('@repo/api/src/services/turn/db', () => ({ turnClients: () => ({}) }));
vi.mock('@repo/api/src/services/fusion/background', () => ({ handReviewToServer: vi.fn() }));
vi.mock('@repo/api/src/lib/envValidator', () => ({ readTurnRouteEnv: () => ({ url: 'https://db.test', anonKey: 'anon', serviceKey: 'service',
  databaseHost: 'db.test', environment: 'test' }) }));
import { POST } from './route';

describe('POST /api/turn', () => {
  beforeEach(() => mocks.handle.mockClear());

  it('hands the free chat its tools: without them it silently answers with none (staging, 2026-11-01)', async () => {
    await POST(new Request('https://graylum.test/api/turn', { method: 'POST' }) as unknown as NextRequest);
    const deps = mocks.handle.mock.calls[0]![1] as { chat: { tools?: Record<string, unknown> } };
    expect(deps.chat.tools).toMatchObject({ library: true, skills: expect.any(Function), voice: expect.any(Function),
      benchmarkAccounts: expect.any(Function) });
    // Tests and the load-test stub only: the route never swaps the Vault or the real suppliers.
    expect(deps.chat.tools).not.toHaveProperty('readKey');
    expect(deps.chat.tools).not.toHaveProperty('vendors');
  });
});
