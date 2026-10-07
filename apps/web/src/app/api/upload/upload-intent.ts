/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RpcResult = { data: unknown; error: unknown };
export type UploadClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  storage: { from(bucket: string): {
    upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }):
      Promise<{ data: { path: string } | null; error: unknown }>;
    remove(paths: string[]): Promise<{ data: unknown; error: unknown }>;
    list(prefix: string, options: { search: string; limit: number }): Promise<{ data: Array<{ name: string }> | null; error: unknown }>;
  } };
};
type Outcome = { status: 200; path: string } | { status: 400 | 403 | 503; error: string };
function finishShape(value: unknown): value is { released: boolean; closed: boolean } {
  return !!value && typeof value === 'object' && 'released' in value && 'closed' in value
    && typeof value.released === 'boolean' && typeof value.closed === 'boolean';
}

/** The database intent spans the Storage request. Unknown outcomes deliberately keep it open. */
export async function uploadWithIntent(input: {
  client: UploadClient; profileId: string; mime: string; body: Uint8Array; uploadId?: string; timeoutMs?: number;
}): Promise<Outcome> {
  const uploadId = input.uploadId ?? randomUUID();
  const timeoutMs = input.timeoutMs ?? 10_000;
  const ext = EXTENSIONS[input.mime];
  if (!UUID.test(input.profileId) || !UUID.test(uploadId) || !ext || input.body.byteLength > 5 * 1024 * 1024
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    return { status: 400, error: '附件参数无效' };
  }
  const pending: Outcome = { status: 503, error: '附件上传状态待核对，请勿重复上传' };
  const bounded = async <T>(operation: () => PromiseLike<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('UPLOAD_PENDING')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const args = { p_profile_id: input.profileId, p_upload_id: uploadId };
  const basename = `${uploadId}.${ext}`;
  const path = `${input.profileId}/${basename}`;
  try {
    const begun = await bounded(() => input.client.rpc('ticket_upload_begin', args));
    if (begun.error || !begun.data || typeof begun.data !== 'object' || !('admitted' in begun.data)
      || begun.data.admitted !== true) return pending;
    const bucket = input.client.storage.from('ticket-attachments');
    const uploaded = await bounded(() => bucket.upload(path, input.body, { contentType: input.mime, upsert: false }));
    // A rejected/timed-out request could still store bytes later. Do not release, delete, recreate the bucket or resend.
    if (uploaded.error || uploaded.data?.path !== path) return pending;
    const finished = await bounded(() => input.client.rpc('ticket_upload_finish', { ...args, p_absent: false }));
    if (finished.error || !finishShape(finished.data)) return pending;
    if (finished.data.released && !finished.data.closed) return { status: 200, path };
    if (!finished.data.closed || finished.data.released) return pending;
    // The original upload has definitively finished; deletion uncertainty can now be resolved by a readback.
    try { await bounded(() => bucket.remove([path])); } catch { /* No retry: read actual object state below. */ }
    // SDK exists() treats both HTTP 400 and 404 as false-with-error. Only a successful exact-name search proves absence here.
    const listed = await bounded(() => bucket.list(input.profileId, { search: basename, limit: 2 }));
    if (listed.error || !Array.isArray(listed.data) || listed.data.length !== 0) return pending;
    const released = await bounded(() => input.client.rpc('ticket_upload_finish', { ...args, p_absent: true }));
    if (released.error || !finishShape(released.data) || !released.data.released || !released.data.closed) return pending;
    return { status: 403, error: '账号已关闭，附件已清除' };
  } catch { return pending; }
}
