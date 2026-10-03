import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../../../../apps/web/package.json', import.meta.url));
const { NextRequest } = webRequire('next/server');

const state = vi.hoisted(() => ({ limit: vi.fn(), auth: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class {} }));
vi.mock('@upstash/ratelimit', () => ({ Ratelimit: class {
  static slidingWindow = () => 'window';
  limit = state.limit;
} }));

const id = '00000000-0000-4000-8000-000000000001';
const scope = { projectId: id, roundId: id, stepId: 'step' };
const workflow = { id: 'flow', version: 1, kind: 'document',
  steps: [{ id: 'step', title: 'Step', dependsOn: [], resources: ['SKILL.md'], minLength: 1,
    maxLength: 2000, requiresEvidence: false, requiredCapabilities: [] }],
  report: { id: 'report', version: 1, title: 'Report', sections: [{ title: 'Section', stepId: 'step' }] },
};
function fixture() {
  const reads: string[] = [];
  const user = { id, email: 'fixture@example.test', email_confirmed_at: '2026-01-01' };
  const query = { select() { return this; }, eq() { return this; },
    single: async () => ({ data: { id, role: 'user', status: 'active', nickname: 'Fictional', email: 'fixture@example.test', credits: 100, created_at: '2020-01-01' }, error: null }) };
  const client = { auth: { getUser: async () => ({ data: { user }, error: null }) }, from: () => query };
  const rpc = vi.fn((name: string, params: any) => {
    reads.push(name);
    let data: unknown = null;
    if (name === 'agent_slice_result' && params.p_action === 'read') data = { state: 'pending' };
    else if (name === 'artifact_query' && params.p_action === 'resolve') data = { moduleId: id, skillId: id, revisionId: id, workflow };
    else if (!(name === 'artifact_generation' && params.p_action === 'get') && name !== 'research_lookup') {
      throw new Error(`Unexpected post-admission RPC: ${name}`);
    }
    const response = Promise.resolve({ data, error: null });
    return Object.assign(response, { abortSignal: () => response });
  });
  const settings = { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: null, error: null }) };
  return { client, admin: { rpc, from: () => settings }, user, reads };
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.doMock(webRequire.resolve('@supabase/ssr'), () => ({ createServerClient: () => ({ auth: { getUser: state.auth } }) }));
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('RATE_LIMIT_FAIL_CLOSED', 'false');
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  state.auth.mockResolvedValue({ data: { user: null }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const entries = ['generation quote', 'generation execute', 'slice router', 'research search', 'research cancel', 'checkout', 'subscription change'] as const;
for (const entry of entries) {
  describe(entry, () => {
    it.each(['over limit', 'backend error', 'timeout', 'missing config'] as const)('rejects %s before paid work', async fault => {
      if (fault === 'missing config') vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      if (fault === 'backend error') state.limit.mockRejectedValue(new Error('synthetic Redis failure'));
      if (fault === 'over limit') state.limit.mockImplementation(async () => ({ success: false, limit: 20, remaining: 0, reset: Date.now() + 60000 }));
      if (fault === 'timeout') { vi.useFakeTimers(); state.limit.mockImplementation(() => new Promise(() => {})); }
      const f = fixture();
      const transport = vi.fn(() => { throw new Error('Provider must never run'); });
      let run: () => Promise<unknown>;
      if (entry.startsWith('generation')) {
        const { workbenchGeneration } = await import('../artifacts/generation');
        const service = workbenchGeneration(f.client as never, f.admin as never, transport as never);
        const input = { ...scope, instruction: '', expectedSteps: { step: { version: 0, reviewVersion: 0 } } };
        run = entry === 'generation quote' ? () => service.quote(input) : () => service.generate({ ...input, requestId: id, quoteHash: 'a'.repeat(64), budgetCredits: 1 });
      } else if (entry === 'slice router') {
        const { agentSliceRouter } = await import('../../routers/agentSlice');
        const caller = agentSliceRouter.createCaller({ user: f.user, isEmailVerified: true, supabase: f.client,
          supabaseAuth: f.client, supabaseAdmin: f.admin, hasSupabaseAdminPrivileges: true } as never);
        run = () => caller.executePhase({ executionId: id, phase: 'reply' });
      } else if (entry.startsWith('research')) {
        const { workbenchSearch } = await import('../research/workbenchSearch');
        const service = workbenchSearch(f.client as never, f.admin as never, transport as never);
        const input = { ...scope, requestId: id, query: 'synthetic query' };
        run = entry === 'research search' ? () => service.search(input) : () => service.cancel(input);
      } else {
        const { assertCheckoutRateLimit, assertSubscriptionChangeRateLimit } = await import('../stripe');
        run = () => (entry === 'checkout' ? assertCheckoutRateLimit : assertSubscriptionChangeRateLimit)(id,
          new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' }));
      }
      const assertion = expect(run()).rejects.toMatchObject({
        code: fault === 'over limit' ? 'TOO_MANY_REQUESTS' : 'SERVICE_UNAVAILABLE',
        cause: { retryAfter: 60 },
      });
      if (fault === 'timeout') await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(transport).not.toHaveBeenCalled();
      expect(f.reads.every(name => ['agent_slice_result', 'artifact_query', 'artifact_generation', 'research_lookup'].includes(name))).toBe(true);
    });
  });
}

describe('real proxy IP admission', () => {
  it.each(['healthy', 'over limit', 'backend error', 'timeout', 'missing config', 'SDK timeout'] as const)('%s', async fault => {
    state.limit.mockImplementation(async () => ({ success: fault !== 'over limit', limit: 60, remaining: 0, reset: Date.now() + 60000 }));
    if (fault === 'missing config') vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    if (fault === 'backend error') state.limit.mockRejectedValue(new Error('Redis unavailable'));
    if (fault === 'SDK timeout') state.limit.mockResolvedValue({ success: true, reason: 'timeout' });
    if (fault === 'timeout') { vi.useFakeTimers(); state.limit.mockImplementation(() => new Promise(() => {})); }
    const { proxy } = await import('@/proxy');
    const pending = proxy(new NextRequest('http://localhost/api/trpc/test', { headers: { 'x-forwarded-for': '203.0.113.7' } }));
    if (fault === 'timeout') await vi.advanceTimersByTimeAsync(500);
    const response = await pending;
    expect(response.status).toBe(fault === 'healthy' ? 200 : fault === 'over limit' ? 429 : 503);
    if (fault === 'healthy') expect(state.auth).toHaveBeenCalled();
    else {
      expect(state.auth).not.toHaveBeenCalled();
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(await response.json()).toMatchObject({ retryAfter: 60 });
    }
  });
});
