/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), access: vi.fn(), status: vi.fn(), finalize: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@repo/api/src/lib/auth', () => ({ isEmailVerified: () => true }));
vi.mock('@repo/api/src/middleware/securityChecks', () => ({ checkUserStatus: mocks.status }));
vi.mock('@/lib/ordinary-chat-access', () => ({ assertChatRecoveryAccess: mocks.access }));
vi.mock('@repo/api/src/services/billing', () => ({ BillingService: class {
  finalizeAISuccess = mocks.finalize;
} }));
import { GET, POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
let row: Record<string, any>;
let rpc: ReturnType<typeof vi.fn>;
const request = (authenticated = true) => new NextRequest(`https://graylum.test/api/ai/requests?requestId=${id}`, {
  headers: authenticated ? { authorization: 'Bearer fixture' } : {},
});
beforeEach(() => {
  vi.clearAllMocks();
  row = {
    request_id: id, user_id: 'actor', writer_token: 'writer', conversation_id: 'conversation',
    input: { message: 'saved message' }, state: 'responded', pre_deduct_id: 'hold',
    response_params: { p_assistant_message: 'saved answer', p_total_cost_usd: 0.1, p_total_credits: 5 },
    updated_at: new Date().toISOString(), reservation: { balance_before: 20, balance_after: 10 },
  };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row }) };
  rpc = vi.fn(async () => ({ data: row }));
  const client = { from: () => query, rpc, auth: { getUser: async () => ({ data: { user: { id: 'actor' } } }) } };
  mocks.createClient.mockReturnValue(client);
  mocks.access.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue(undefined);
  mocks.finalize.mockImplementation(async () => { row.state = 'succeeded'; row.billing_result = {}; });
});
describe('retained legacy request recovery', () => {
  it('settles the saved response through GET after sending is disabled', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.request.state).toBe('succeeded');
    expect(body.request.content).toBe('saved answer');
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ requestId: id, preDeductId: 'hold' }));
    expect(mocks.access).toHaveBeenCalled();
  });
  it('leaves unknown requests reserved without refunds or failure settlement', async () => {
    row.state = 'unknown'; row.response_params = null;
    const body = await (await GET(request())).json();
    expect(body.request.state).toBe('unknown');
    expect(body.request.billing.state).toBe('reserved');
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('keeps a failed settlement recoverable', async () => {
    mocks.finalize.mockRejectedValue(new Error('fixture unavailable'));
    const body = await (await GET(request())).json();
    expect(body.request.state).toBe('responded');
    expect(body.request.billing.state).toBe('reserved');
  });
  it('keeps the existing stop endpoint available', async () => {
    row.state = 'unknown'; row.response_params = null;
    expect((await POST(request())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('ordinary_chat_transition', expect.objectContaining({ p_action: 'stop' }));
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it('still rejects anonymous access before opening a database client', async () => {
    expect((await GET(request(false))).status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('still rejects another actor before settlement', async () => {
    row.user_id = 'other';
    expect((await GET(request())).status).toBe(403);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
