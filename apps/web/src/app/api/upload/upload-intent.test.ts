/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { uploadWithIntent, type UploadClient } from './upload-intent';

const actor = '00000000-0000-4000-8000-000000000001';
const uploadId = '00000000-0000-4000-8000-000000000002';
const path = `${actor}/${uploadId}.png`;
function setup(closed = false) {
  const events: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    events.push(name + (args.p_absent ? ':absent' : ''));
    return { data: name === 'ticket_upload_begin' ? { admitted: true }
      : { released: !closed || args.p_absent === true, closed }, error: null };
  });
  const bucket = {
    upload: vi.fn(async () => { events.push('upload'); return { data: { path }, error: null }; }),
    remove: vi.fn(async () => { events.push('remove'); return { data: [], error: null }; }),
    list: vi.fn(async () => { events.push('list'); return { data: [] as Array<{ name: string }>, error: null }; }),
  };
  const client = { rpc, storage: { from: vi.fn(() => bucket) } } as UploadClient;
  return { rpc, bucket, client, events, input: { client, profileId: actor, uploadId, mime: 'image/png', body: new Uint8Array([1]) } };
}
describe('ticket upload intent', () => {
  it('admits before Storage and releases only after successful same-path upload', async () => {
    const f = setup(); expect(await uploadWithIntent(f.input)).toEqual({ status: 200, path });
    expect(f.events).toEqual(['ticket_upload_begin', 'upload', 'ticket_upload_finish']);
    expect(f.bucket.upload).toHaveBeenCalledExactlyOnceWith(path, f.input.body, { contentType: 'image/png', upsert: false });
    expect(f.rpc).toHaveBeenLastCalledWith('ticket_upload_finish', { p_profile_id: actor, p_upload_id: uploadId, p_absent: false });
    expect(f.bucket.remove).not.toHaveBeenCalled();
  });
  it('cleans a completed upload racing account closure before releasing its original intent', async () => {
    const f = setup(true); expect((await uploadWithIntent(f.input)).status).toBe(403);
    expect(f.events).toEqual(['ticket_upload_begin', 'upload', 'ticket_upload_finish', 'remove', 'list', 'ticket_upload_finish:absent']);
    expect(f.bucket.remove).toHaveBeenCalledExactlyOnceWith([path]);
    expect(f.bucket.list).toHaveBeenCalledExactlyOnceWith(actor, { search: `${uploadId}.png`, limit: 2 });
  });
  it.each([{ admitted: false }, {}, null])('denied or malformed begin never uploads: %j', async data => {
    const f = setup(); f.rpc.mockResolvedValueOnce({ data, error: null } as never);
    expect((await uploadWithIntent(f.input)).status).toBe(503); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it('begin network uncertainty never uploads or finishes', async () => {
    const f = setup(); f.rpc.mockRejectedValueOnce(new Error('private network text'));
    const result = await uploadWithIntent(f.input);
    expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain('private');
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
  it.each(['reject', 'timeout', 'bucket_missing', 'wrong_path'])('uncertain upload retains intent without retry: %s', async failure => {
    const f = setup(true);
    if (failure === 'reject') f.bucket.upload.mockRejectedValue(new Error('network error'));
    if (failure === 'timeout') f.bucket.upload.mockImplementation(() => new Promise(() => {}));
    if (failure === 'bucket_missing') f.bucket.upload.mockResolvedValue({ data: null, error: { message: 'Bucket not found' } } as never);
    if (failure === 'wrong_path') f.bucket.upload.mockResolvedValue({ data: { path: 'other/object' }, error: null });
    expect((await uploadWithIntent({ ...f.input, timeoutMs: 2 })).status).toBe(503);
    expect(f.bucket.upload).toHaveBeenCalledOnce(); expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.bucket.remove).not.toHaveBeenCalled(); expect(f.bucket.list).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: { status: 404 } }, { data: false, error: { status: 400 } },
    { data: [], error: { status: 401 } }, { data: [{ name: `${uploadId}.png` }], error: null },
  ])('never mistakes absence-like or error responses for successful deletion: %j', async result => {
    const f = setup(true); f.bucket.list.mockResolvedValue(result as never);
    expect((await uploadWithIntent(f.input)).status).toBe(503);
    expect(f.rpc.mock.calls.some(([, args]) => args.p_absent === true)).toBe(false);
  });
  it('readbacks uncertain remove once, without resending it', async () => {
    const f = setup(true); f.bucket.remove.mockRejectedValue(new Error('timeout after deletion'));
    expect((await uploadWithIntent(f.input)).status).toBe(403); expect(f.bucket.remove).toHaveBeenCalledOnce();
    expect(f.bucket.list).toHaveBeenCalledOnce();
  });
  it('ambiguous finish leaves the original intent untouched and does not delete blindly', async () => {
    const f = setup(true);
    f.rpc.mockImplementation(async name => {
      if (name === 'ticket_upload_begin') return { data: { admitted: true }, error: null };
      throw new Error('finish committed but disconnected');
    });
    expect((await uploadWithIntent(f.input)).status).toBe(503); expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([
    { profileId: '../other' }, { uploadId: '../file.png' }, { mime: 'text/html' },
    { body: new Uint8Array(5 * 1024 * 1024 + 1) }, { timeoutMs: 0 },
  ])('rejects invalid parameters before all I/O', async patch => {
    const f = setup(); expect((await uploadWithIntent({ ...f.input, ...patch })).status).toBe(400);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.bucket.upload).not.toHaveBeenCalled();
  });
});
