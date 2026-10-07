/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), log: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/server-log', () => ({ logServerError: mocks.log }));
import { POST } from './route';

const actor = '00000000-0000-4000-8000-000000000001';
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const request = (options: { auth?: boolean; file?: File | string | null } = {}) => {
  const form = new FormData();
  const file = options.file === undefined ? new File([bytes], 'private-original-name.png', { type: 'image/png' }) : options.file;
  if (file !== null) form.set('file', file);
  return new NextRequest('https://graylum.test/api/upload', {
    method: 'POST', headers: options.auth === false ? {} : { authorization: 'Bearer synthetic-token' }, body: form,
  });
};
function setup() {
  const events: string[] = [];
  const state = { role: 'user', status: 'active', maintenance: false, closedAfterUpload: false };
  const getUser = vi.fn(async (token: string) => {
    events.push('auth');
    expect(token).toBe('synthetic-token');
    return { data: { user: { id: actor } }, error: null };
  });
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        events.push(table);
        return { data: table === 'profiles' ? { role: state.role, status: state.status } : { value: state.maintenance }, error: null };
      }),
    };
    return query;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    events.push(name + (args.p_absent ? ':absent' : ''));
    return { data: name === 'ticket_upload_begin' ? { admitted: true }
      : { released: !state.closedAfterUpload || args.p_absent === true, closed: state.closedAfterUpload }, error: null };
  });
  const bucket = {
    upload: vi.fn(async (path: string, _body: Uint8Array, _options: { contentType: string; upsert: boolean }) => {
      void _body; void _options;
      events.push('upload'); return { data: { path }, error: null };
    }),
    remove: vi.fn(async (_paths: string[]) => { void _paths; events.push('remove'); return { data: [], error: null }; }),
    list: vi.fn(async (_prefix: string, _options: { search: string; limit: number }) => {
      void _prefix; void _options;
      events.push('list'); return { data: [], error: null };
    }),
  };
  const storage = { from: vi.fn(() => bucket) };
  const auth = { auth: { getUser } }, admin = { from, rpc, storage };
  mocks.createClient.mockImplementation((_url: string, key: string) => {
    if (key === 'synthetic-anon') return auth;
    if (key === 'synthetic-service') return admin;
    throw new Error('Unexpected synthetic client key');
  });
  return { events, state, getUser, rpc, bucket, storage };
}
let f: ReturnType<typeof setup>;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  network = vi.fn(() => { throw new Error('Network forbidden in route fixture'); });
  vi.stubGlobal('fetch', network);
  f = setup();
});
afterEach(() => {
  try { expect(network).not.toHaveBeenCalled(); }
  finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

describe('POST /api/upload HTTP boundary', () => {
  it('parses multipart bytes and returns only the canonical path after begin, upload and finish', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['path']);
    expect(body.path).toMatch(new RegExp(`^${actor}/[0-9a-f-]{36}\\.png$`));
    expect(body.path).not.toContain('private-original-name');
    expect(f.events).toEqual(['auth', 'profiles', 'system_settings', 'ticket_upload_begin', 'upload', 'ticket_upload_finish']);
    expect(f.storage.from).toHaveBeenCalledExactlyOnceWith('ticket-attachments');
    expect(f.bucket.upload).toHaveBeenCalledExactlyOnceWith(body.path, Buffer.from(bytes), { contentType: 'image/png', upsert: false });
    const uploadId = body.path.slice(actor.length + 1, -4);
    expect(f.rpc).toHaveBeenNthCalledWith(1, 'ticket_upload_begin', { p_profile_id: actor, p_upload_id: uploadId });
    expect(f.rpc).toHaveBeenNthCalledWith(2, 'ticket_upload_finish', { p_profile_id: actor, p_upload_id: uploadId, p_absent: false });
  });
  it.each(['deleted', 'suspended'])('denies %s profile before intent or Storage', async status => {
    f.state.status = status;
    expect((await POST(request())).status).toBe(403);
    expect(f.events).toEqual(['auth', 'profiles']);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('rejects an absent Authorization header before constructing clients', async () => {
    expect((await POST(request({ auth: false }))).status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('rejects an invalid session before profile checks or Storage', async () => {
    f.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'invalid' } } as never);
    expect((await POST(request())).status).toBe(401);
    expect(f.events).toEqual([]); expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it.each([null, 'not-a-file'])('rejects missing or non-file form input: %s', async file => {
    expect((await POST(request({ file }))).status).toBe(400);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('rejects unsupported MIME before admission', async () => {
    const file = new File(['PRIVATE'], 'pretend.png', { type: 'text/plain' });
    expect((await POST(request({ file }))).status).toBe(400);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('blocks non-admin uploads during maintenance', async () => {
    f.state.maintenance = true;
    expect((await POST(request())).status).toBe(503);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('allows an active admin through maintenance using the same upload intent', async () => {
    f.state.maintenance = true; f.state.role = 'admin';
    expect((await POST(request())).status).toBe(200);
    expect(f.bucket.upload).toHaveBeenCalledOnce(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('returns 403 without a path after compensating a closure that races the HTTP upload', async () => {
    f.state.closedAfterUpload = true;
    const response = await POST(request());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['error']); expect(body.path).toBeUndefined();
    expect(f.events).toEqual(['auth', 'profiles', 'system_settings', 'ticket_upload_begin', 'upload',
      'ticket_upload_finish', 'remove', 'list', 'ticket_upload_finish:absent']);
    const path = f.bucket.upload.mock.calls[0][0];
    expect(f.bucket.remove).toHaveBeenCalledExactlyOnceWith([path]);
    expect(f.rpc.mock.calls[2][1]).toEqual({ ...f.rpc.mock.calls[0][1], p_absent: true });
  });
});
