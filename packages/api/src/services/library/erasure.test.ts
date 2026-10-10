/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./cleanup', () => ({ cleanupLibrary: vi.fn() }));
import { cleanupLibrary } from './cleanup';
import { createLibraryErasureAdapter } from './erasure';
const actor = '00000000-0000-4000-8000-000000000001';
const doc = '00000000-0000-4000-8000-000000000002';
const path = `${actor}/${doc}/original`;
const text = `${actor}/${doc}/text`;
function fixture() {
  const objects = new Set([path, text]);
  let proved = false, remaining = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'library_erasure_proof') {
      if (args.verified) proved = true;
      return { data: proved, error: null };
    }
    if (name === 'library_erasure_remaining') return { data: String(remaining), error: null };
    throw new Error(name);
  });
  const storage = {
    scan: vi.fn(async () => ({ paths: [...objects], cursor: null as string | null })),
    absent: vi.fn(async (key: string) => !objects.has(key)),
    remove: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  const adapter = () => createLibraryErasureAdapter({ rpc } as never,
    { profileId: actor, requestId: doc, token: actor, storage: storage as never });
  return { objects, storage, rpc, adapter, setRemaining: (n: number) => { remaining = n; } };
}
beforeEach(() => { vi.mocked(cleanupLibrary).mockResolvedValue({ failed: 0 } as never); });
it('proves both original and text absent and reuses durable proof on restart', async () => {
  const f = fixture();
  expect(await f.adapter().cleanSubject(actor)).toEqual({ complete: true, remaining: 0, manualReview: 0 });
  expect(f.storage.remove.mock.calls).toEqual([[path], [text]]);
  expect(f.rpc).toHaveBeenLastCalledWith('library_erasure_proof', { a: actor, rid: doc, token: actor, verified: true });
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: true });
  expect(f.storage.scan).toHaveBeenCalledTimes(2);
});
it('does not accept an empty prefix while live reservations or recognition settlement remain', async () => {
  const f = fixture(); f.objects.clear(); f.setRemaining(1);
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: false, remaining: 1 });
  expect(f.storage.scan).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls.some(([, args]) => args.verified)).toBe(false);
});
it('observes an uncertain deletion on resume before retry and only proves a fresh empty prefix', async () => {
  const f = fixture();
  f.storage.remove.mockImplementationOnce(async key => { f.objects.delete(key); throw new Error('lost response'); });
  await expect(f.adapter().cleanSubject(actor)).rejects.toThrow('lost response');
  expect(f.rpc.mock.calls.some(([, args]) => args.verified)).toBe(false);
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: true });
  expect(f.storage.remove.mock.calls).toEqual([[path], [text]]);
});
it('unknown paths and incomplete enumeration cannot prove completion', async () => {
  const f = fixture(); f.objects.clear(); f.objects.add(`${actor}/unrecognized`);
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: false, manualReview: 1 });
  expect(f.storage.remove).not.toHaveBeenCalled();
  f.objects.clear(); f.storage.scan.mockResolvedValue({ paths: [], cursor: 'more' });
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: false });
});
it('does not prove absence on listing failure, cleanup failure, or another subject', async () => {
  const f = fixture();
  f.storage.scan.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(f.adapter().cleanSubject(actor)).rejects.toThrow('provider unavailable');
  vi.mocked(cleanupLibrary).mockResolvedValueOnce({ failed: 1 } as never);
  expect(await f.adapter().cleanSubject(actor)).toMatchObject({ complete: false });
  await expect(f.adapter().cleanSubject(doc)).rejects.toThrow('ERASURE_IDENTITY_CHANGED');
  expect(f.rpc.mock.calls.some(([, args]) => args.verified)).toBe(false);
});
