/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const target = new URL(connectionString);
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
const databaseName = target.pathname.replace(/^\//, '');

if (
  process.env.SKILL1A_ALLOW_DISPOSABLE_DB !== 'yes'
  || !isLoopback
  || !databaseName.startsWith('skill1a_')
) {
  throw new Error('refusing non-disposable database; require loopback skill1a_* DB and SKILL1A_ALLOW_DISPOSABLE_DB=yes');
}

const actorId = randomUUID();
const skillId = randomUUID();
const clients = [new Client({ connectionString }), new Client({ connectionString }), new Client({ connectionString })];

const waitForBlockedLock = async (observer, pid) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`publisher backend ${pid} did not block on the row lock`);
};

try {
  await Promise.all(clients.map((client) => client.connect()));
  const [first, second, observer] = clients;
  const [{ rows: firstPidRows }, { rows: secondPidRows }] = await Promise.all([
    first.query('SELECT pg_backend_pid() AS pid'),
    second.query('SELECT pg_backend_pid() AS pid'),
  ]);
  const firstPid = firstPidRows[0].pid;
  const secondPid = secondPidRows[0].pid;

  if (firstPid === secondPid) throw new Error('concurrency test requires independent PostgreSQL backends');

  await observer.query(
    'INSERT INTO public.profiles (id, email) VALUES ($1, $2)',
    [actorId, `skill-1a-concurrency-${actorId}@example.test`],
  );
  await observer.query('BEGIN');
  await observer.query('SET LOCAL ROLE service_role');
  await observer.query(
    `INSERT INTO public.skills (id, skill_key, draft_content, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)`,
    [skillId, `skill-1a-concurrency-${skillId}`, 'concurrent content', actorId],
  );
  await observer.query('COMMIT');

  await first.query('BEGIN');
  await first.query('SET LOCAL ROLE service_role');
  await first.query('SELECT id FROM public.skills WHERE id = $1 FOR UPDATE', [skillId]);

  await second.query('BEGIN');
  await second.query('SET LOCAL ROLE service_role');
  const secondPublish = second.query(
    'SELECT * FROM public.atomic_publish_skill($1, $2, $3::jsonb)',
    [skillId, actorId, JSON.stringify({ publisher: 'second' })],
  );

  await waitForBlockedLock(observer, secondPid);

  const firstPublish = await first.query(
    'SELECT * FROM public.atomic_publish_skill($1, $2, $3::jsonb)',
    [skillId, actorId, JSON.stringify({ publisher: 'first' })],
  );
  await first.query('COMMIT');
  const secondResult = await secondPublish;
  await second.query('COMMIT');

  const versions = [
    firstPublish.rows[0].published_version,
    secondResult.rows[0].published_version,
  ].map(Number).sort((a, b) => a - b);
  const revisionResult = await observer.query(
    `SELECT array_agg(version ORDER BY version) AS versions, count(*)::int AS count
       FROM public.skill_revisions
      WHERE skill_id = $1`,
    [skillId],
  );

  if (JSON.stringify(versions) !== JSON.stringify([1, 2])) {
    throw new Error(`concurrent publish returned invalid versions: ${JSON.stringify(versions)}`);
  }
  if (revisionResult.rows[0].count !== 2 || revisionResult.rows[0].versions.join(',') !== '1,2') {
    throw new Error(`concurrent publish created invalid revisions: ${JSON.stringify(revisionResult.rows[0])}`);
  }

  console.log(JSON.stringify({
    decision: 'SKILL_1A_CONCURRENT_PUBLISH_PASS',
    backendPids: [firstPid, secondPid],
    versions,
    revisionCount: revisionResult.rows[0].count,
  }));
} catch (error) {
  await Promise.allSettled(clients.map((client) => client.query('ROLLBACK')));
  throw error;
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
}
