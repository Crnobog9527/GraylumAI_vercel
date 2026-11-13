/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** PROFILE-AVATAR (Owner 2026-11-12) migration: the avatar bucket and who may write profiles.avatar_url. It lives in this
 * suite because it is a CI suite that builds the whole schema from the repository; the upload logic itself is unit-tested
 * (packages/api/src/services/profileAvatar). */
export async function profileAvatarCases({ admin, service, connect }) {
  const migrations = resolve(import.meta.dirname, '../../migrations');
  const file = readdirSync(migrations).find(name => /^\d{4}_profile_avatar\.sql$/.test(name));
  assert.ok(file, 'the profile avatar migration exists');
  const bucket = async () => (await admin.query(`SELECT public,file_size_limit::int AS size,allowed_mime_types AS types
    FROM storage.buckets WHERE id='profile-avatars'`)).rows;
  const expected = [{ public: true, size: 2097152, types: ['image/jpeg', 'image/png', 'image/webp'] }];
  assert.deepEqual(await bucket(), expected, 'public read, 2 MB, JPEG/PNG/WebP');
  // Only the service writes objects: no storage policy at all, so the API roles cannot upload, overwrite, list or delete.
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='storage'")).rows[0].n, 0);
  const privilege = async (role, kind) => (await admin.query(
    "SELECT has_column_privilege($1,'public.profiles','avatar_url',$2) AS v", [role, kind])).rows[0].v;
  assert.equal(await privilege('service_role', 'UPDATE'), true);
  assert.equal(await privilege('service_role', 'SELECT'), true);
  for (const role of ['anon', 'authenticated']) assert.equal(await privilege(role, 'UPDATE'), false, role);

  // The upload route's compare-and-set, as the service role: it wins once against the expected old value, never twice.
  const user = randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,status) VALUES($1,0,'active')", [user]);
  const url = n => `https://proj.supabase.co/storage/v1/object/public/profile-avatars/${user}/${n}.webp`;
  const cas = (expected, next) => service.query(`UPDATE profiles SET avatar_url=$3 WHERE id=$1 AND status='active'
    AND is_deleted='false' AND avatar_url IS NOT DISTINCT FROM $2 RETURNING avatar_url`, [user, expected, next]);
  assert.equal((await cas(null, url(1))).rowCount, 1);
  assert.equal((await cas(null, url(2))).rowCount, 0, 'a racing upload that read the old value loses');
  assert.equal((await cas(url(1), url(3))).rowCount, 1);
  await admin.query("UPDATE profiles SET status='closed' WHERE id=$1", [user]);
  assert.equal((await cas(url(3), url(4))).rowCount, 0, 'a closed account is not written');

  // A signed-in user cannot set any avatar URL directly, not even on their own row.
  const self = await connect();
  await self.query('BEGIN');
  await self.query("SELECT set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true)",
    [JSON.stringify({ sub: user, role: 'authenticated' }), user]);
  await self.query('SET LOCAL ROLE authenticated');
  await assert.rejects(() => self.query("UPDATE profiles SET avatar_url='https://evil.test/x.png' WHERE id=$1", [user]),
    /permission denied/);
  await self.query('ROLLBACK');

  // Re-running the migration changes nothing.
  await admin.query(readFileSync(resolve(migrations, file), 'utf8'));
  assert.deepEqual(await bucket(), expected);
  assert.equal(await privilege('authenticated', 'UPDATE'), false);
  return ['avatar-bucket-public-2mb-images', 'avatar-no-storage-policies', 'avatar-url-service-write-only',
    'avatar-cas-once', 'avatar-closed-account-not-written', 'avatar-user-direct-write-denied', 'avatar-migration-rerun'];
}
