/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Chat photos migration (Owner 2026-11-13: kept with their message for good, in Supabase Storage; deleted with the conversation and
 * the account): the private bucket and chat_photos_orphaned, which names the photos of deleted conversations for the 5-minute cron.
 * In this suite because it builds the whole schema; keeping, reading, sharing and deleting are unit-tested
 * (packages/api/src/services/chatPhotos). */
export async function chatPhotosCases({ admin, service, connect }) {
  const migrations = resolve(import.meta.dirname, '../../migrations');
  const file = readdirSync(migrations).find(name => /^\d{4}_chat_photos\.sql$/.test(name));
  assert.ok(file, 'the chat photos migration exists');
  const bucket = async () => (await admin.query(`SELECT public,file_size_limit::int AS size,allowed_mime_types AS types
    FROM storage.buckets WHERE id='chat-photos'`)).rows;
  const expected = [{ public: false, size: 1048576, types: ['image/jpeg'] }];
  assert.deepEqual(await bucket(), expected, 'private, 1 MB, JPEG only');
  // Only the service reads or writes objects: no storage policy at all, so the API roles cannot list, read or upload.
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='storage'")).rows[0].n, 0);

  const profile = async () => {
    const id = randomUUID();
    await admin.query("INSERT INTO profiles(id,credits,status) VALUES($1,0,'active')", [id]);
    return id;
  };
  const session = async (actor, columns = {}) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')`,
      [id, actor, JSON.stringify({ kind: 'free_chat', probe: randomUUID() }), randomUUID()]);
    // The deletion marks as the erasure functions leave them: the marker guard lets only the table owner set content_deleted_at (never
    // on insert), and an erased row has its content cleared in the same write (0150's allow-list).
    if (columns.contentDeleted) await admin.query('UPDATE runtime_sessions SET content_deleted_at=$2 WHERE id=$1', [id, columns.contentDeleted]);
    if (columns.erased) await admin.query('UPDATE runtime_sessions SET scope=NULL, start_payload=NULL, erased_at=$2 WHERE id=$1',
      [id, columns.erased]);
    return id;
  };
  const [me, other] = [await profile(), await profile()];
  const live = await session(me), deleted = await session(me, { contentDeleted: new Date() }), erased = await session(me, { erased: new Date() });
  const gone = randomUUID(), othersLive = await session(other);
  const name = (actor, conversation, turn = 1) => `${actor}/${conversation}.${turn}.0.${randomUUID()}.jpg`;
  const put = (bucketId, objectName, minutes) => admin.query(`INSERT INTO storage.objects(bucket_id,name,created_at)
    VALUES($1,$2,now()-make_interval(mins=>$3))`, [bucketId, objectName, minutes]);
  const keep = name(me, live), keepOld = name(me, live, 2), ofDeleted = name(me, deleted), ofErased = name(me, erased);
  const ofGone = name(me, gone), fresh = name(me, gone, 3), notMine = name(me, othersLive), othersPhoto = name(other, othersLive);
  const avatar = name(me, gone, 4);
  await put('chat-photos', keepOld, 60 * 24 * 400);
  await put('chat-photos', keep, 30);
  await put('chat-photos', ofDeleted, 50);
  await put('chat-photos', ofErased, 40);
  await put('chat-photos', ofGone, 30);
  await put('chat-photos', fresh, 2);
  await put('chat-photos', notMine, 20);
  await put('chat-photos', othersPhoto, 20);
  await put('profile-avatars', avatar, 60);
  const orphaned = async limit => (await service.query('SELECT public.chat_photos_orphaned($1) AS name', [limit])).rows.map(row => row.name);
  // A photo of a live conversation stays however old (no time limit); one of a deleted, erased or vanished conversation is named,
  // oldest first; a photo filed under a conversation of another account is named too (the name does not match its owner).
  assert.deepEqual(await orphaned(10), [ofDeleted, ofErased, ofGone, notMine],
    'deleted, erased, vanished and mismatched conversations only; live photos of any age, fresh uploads and other buckets stay');
  assert.deepEqual(await orphaned(1), [ofDeleted]);
  assert.deepEqual(await orphaned(0), []);
  assert.deepEqual(await orphaned(-5), []);

  // Signed-in users and visitors cannot ask.
  for (const role of ['anon', 'authenticated']) {
    const client = await connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(() => client.query('SELECT public.chat_photos_orphaned(10)'), /permission denied/, role);
    await client.query('ROLLBACK');
  }

  // Re-running the migration changes nothing.
  await admin.query(readFileSync(resolve(migrations, file), 'utf8'));
  assert.deepEqual(await bucket(), expected);
  assert.deepEqual(await orphaned(10), [ofDeleted, ofErased, ofGone, notMine]);
  await admin.query('DELETE FROM storage.objects WHERE name = ANY($1)',
    [[keep, keepOld, ofDeleted, ofErased, ofGone, fresh, notMine, othersPhoto, avatar]]);
  return ['chat-photos-bucket-private-1mb-jpeg', 'chat-photos-no-storage-policies', 'chat-photos-orphans-of-deleted-conversations',
    'chat-photos-live-kept-without-time-limit', 'chat-photos-orphans-limit', 'chat-photos-orphans-service-only', 'chat-photos-migration-rerun'];
}
