import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tasks: [] as Array<() => Promise<void>>, advance: vi.fn(), kick: vi.fn(), error: vi.fn() }));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<void>) => { mocks.tasks.push(task); } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ client: 'service-role' }) }));
vi.mock('@repo/api/src/services', () => ({ logger: { error: mocks.error } }));
vi.mock('@repo/api/src/services/fusion/background', async (original) => ({
  ...(await original<typeof import('@repo/api/src/services/fusion/background')>()),
  advanceReview: mocks.advance, kickAdvance: mocks.kick }));
import { POST } from './route';
import * as route from './route';

const reviewId = '00000000-0000-4000-8000-000000000001';
const request = (body: unknown, authorization = 'Bearer s3cret') => new Request('https://graylum.test/api/fusion/advance',
  { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/fusion/advance', () => {
  beforeEach(() => {
    mocks.tasks.length = 0; mocks.advance.mockReset(); mocks.kick.mockReset(); mocks.error.mockReset();
    vi.stubEnv('CRON_SECRET', 's3cret');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  });

  it('accepts only POST with the exact server secret and a review id; nothing runs otherwise', async () => {
    expect('GET' in route).toBe(false);
    expect((await POST(request({ reviewId, hop: 0 }, 'Bearer wrong'))).status).toBe(401);
    expect((await POST(request({ reviewId, hop: 0 }, 'Bearer s3cretX'))).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await POST(request({ reviewId, hop: 0 }))).status).toBe(401);
    vi.stubEnv('CRON_SECRET', 's3cret');
    expect((await POST(request({ reviewId: 'not-a-uuid', hop: 0 }))).status).toBe(400);
    expect((await POST(request({ reviewId, hop: 0, extra: 1 }))).status).toBe(400);
    expect((await POST(request({ reviewId, hop: 11 }))).status).toBe(400);
    expect(mocks.tasks).toEqual([]);
  });

  it('answers 202 at once, runs one step after the response and relays with the next hop only when it advanced', async () => {
    mocks.advance.mockResolvedValue({ next: true, reason: 'advanced' });
    const response = await POST(request({ reviewId, hop: 2 }));
    expect(response.status).toBe(202);
    expect(mocks.advance).not.toHaveBeenCalled();
    await mocks.tasks[0]!();
    expect(mocks.advance).toHaveBeenCalledWith({ admin: { client: 'service-role' }, reviewId });
    expect(mocks.kick).toHaveBeenCalledWith('https://graylum.test', reviewId, 3);
    mocks.advance.mockResolvedValue({ next: false, reason: 'ended' });
    await POST(request({ reviewId, hop: 0 }));
    await mocks.tasks[1]!();
    expect(mocks.kick).toHaveBeenCalledTimes(1);
  });

  it('stops a relay chain at its last hop with an alert instead of calling itself again', async () => {
    mocks.advance.mockResolvedValue({ next: true, reason: 'advanced' });
    await POST(request({ reviewId, hop: 10 }));
    await mocks.tasks[0]!();
    expect(mocks.kick).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('billing', 'fusion_review_relay_limit', { reviewId, hop: 10 });
  });
});
