/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX B1: a signed library upload URL must stop writing once the account is closed (0376).
// Storage writes one storage.objects row per object; these cases insert that row the way Storage does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BUCKET = 'library-documents';
export async function verifyStorageGuard(admin, service, connect) {
  const third = await connect(); const monitor = await connect();
  await admin.query("UPDATE membership_plans SET library_storage_bytes=2000000000 WHERE level='free'");
  const put = (c, name, bucket = BUCKET) => c.query(
    'INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)', [bucket, name, { size: 5 }]);
  const closed = (fn) => assert.rejects(fn, e => e.code === '42501' && /LIBRARY_UPLOAD_CLOSED/.test(e.message));
  const actor = async () => {
    const id = randomUUID();
    await admin.query('INSERT INTO profiles(id) VALUES($1)', [id]);
    return id;
  };
  const begin = async (a, format = 'txt') => (await service.query(
    "SELECT library_upload_begin($1,$2,$3,$4,'reference',5) v", [a, randomUUID(), `f.${format}`, format])).rows[0].v;

  // Open account, reserved path: the write lands. Other buckets and unknown library paths behave as before/denied.
  const a = await actor();
  const grant = await begin(a);
  await put(admin, grant.path);
  await put(admin, `${a}/${randomUUID()}/original`, 'ticket-attachments');
  await closed(() => put(admin, `${a}/${randomUUID()}/original`));
  // In-place metadata updates (no rename) are not writes of new paths and stay allowed.
  await admin.query('UPDATE storage.objects SET metadata=$2 WHERE bucket_id=$3 AND name=$1', [grant.path, { size: 6 }, BUCKET]);

  // The 10-25 drill: unfinished upload URLs issued before erasure. After confirmation every write is refused,
  // and existing objects can still be removed by cleanup.
  const b = await actor();
  const pending = [await begin(b), await begin(b), await begin(b, 'png'), await begin(b, 'pdf')];
  await service.query('SELECT library_pdf_text_begin($1,$2,5)', [b, pending[3].documentId]);
  const text = `${b}/${pending[3].documentId}/text`;
  await put(admin, pending[0].path);
  await admin.query('SELECT account_erasure_confirm($1,$2)', [b, randomUUID()]);
  for (const grantB of pending.slice(1)) await closed(() => put(admin, grantB.path));
  await closed(() => put(admin, text));
  await admin.query('UPDATE storage.objects SET metadata=$2 WHERE bucket_id=$3 AND name=$1', [pending[0].path, {}, BUCKET]);
  await admin.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2', [BUCKET, pending[0].path]);
  // A rename/move into a closed account's reserved path is a new write and is refused too.
  const moved = `${a}/${randomUUID()}/original`;
  await put(admin, moved, 'ticket-attachments');
  await closed(() => admin.query('UPDATE storage.objects SET bucket_id=$1,name=$2 WHERE bucket_id=$3 AND name=$4',
    [BUCKET, pending[1].path, 'ticket-attachments', moved]));

  // Each closing fact on its own refuses the write: erasure request, non-active status, deleted flag.
  const c = await actor(); const cGrant = await begin(c);
  await admin.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
    VALUES($1,$2,$3,clock_timestamp())`, [c, randomUUID(), randomUUID()]);
  await closed(() => put(admin, cGrant.path));
  for (const change of ["status='disabled'", "status='banned'", "is_deleted='true'"]) {
    const d = await actor(); const dGrant = await begin(d);
    await admin.query(`UPDATE profiles SET ${change} WHERE id=$1`, [d]);
    await closed(() => put(admin, dGrant.path));
    await admin.query("UPDATE profiles SET status='active',is_deleted='false' WHERE id=$1", [d]);
    await put(admin, dGrant.path);
  }

  // Document facts: deleted by the user, already ready, or past the guard window.
  const e = await actor();
  const deleted = await begin(e);
  await service.query('SELECT library_delete($1,$2)', [e, deleted.documentId]);
  await closed(() => put(admin, deleted.path));
  const expired = await begin(e);
  await admin.query("UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 second' WHERE document_id=$1",
    [expired.documentId]);
  await closed(() => put(admin, expired.path));
  const ready = await begin(e);
  await service.query('SELECT library_publish($1,$2,5,$3)', [e, ready.documentId, JSON.stringify([{ title: '', body: 'hello' }])]);
  await closed(() => put(admin, ready.path));
  // The text path of an open document is accepted inside its own guard window.
  const pdf = await begin(e, 'pdf');
  await closed(() => put(admin, `${e}/${pdf.documentId}/text`));
  await service.query('SELECT library_pdf_text_begin($1,$2,5)', [e, pdf.documentId]);
  await put(admin, `${e}/${pdf.documentId}/text`);

  // Race: a write that arrives while erasure confirmation holds the profile waits, then sees the closed account.
  const f = await actor(); const fGrant = await begin(f);
  await admin.query('BEGIN');
  await admin.query('SELECT account_erasure_confirm($1,$2)', [f, randomUUID()]);
  const racing = put(third, fGrant.path);
  let waited = false;
  for (let i = 0; i < 500 && !waited; i++) {
    const n = (await monitor.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO storage.objects%'`)).rows[0].n;
    waited = n === 1;
    if (!waited) await new Promise(r => setTimeout(r, 10));
  }
  await admin.query('COMMIT');
  assert.ok(waited, 'the racing write must wait on the erasure confirmation lock');
  await closed(() => racing);
  // Ordinary profile updates do not wait on an in-flight storage write (KEY SHARE, not SHARE).
  const g = await actor(); const gGrant = await begin(g);
  await third.query('BEGIN');
  await put(third, gGrant.path);
  await admin.query('SET lock_timeout=2000');
  await admin.query('UPDATE profiles SET credits=credits+1 WHERE id=$1', [g]);
  await admin.query('RESET lock_timeout');
  await third.query('COMMIT');
  // Presence check used by the library cleanup cron: true now, false once the trigger is disabled.
  const present = async () => (await service.query('SELECT library_storage_guard_present() v')).rows[0].v;
  assert.equal(await present(), true);
  await admin.query('ALTER TABLE storage.objects DISABLE TRIGGER library_storage_write_guard');
  assert.equal(await present(), false);
  await admin.query('ALTER TABLE storage.objects ENABLE TRIGGER library_storage_write_guard');
  assert.equal(await present(), true);
  console.log('PASS: library storage write guard (open, unknown path, other bucket, erasure drill, closing facts,'
    + ' deleted/ready/expired documents, text path, rename, delete, erasure race, credit updates not blocked, presence check)');
}
