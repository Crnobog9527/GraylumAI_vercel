/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REL-1 core 7 (6): library cleanup backlog drill. The real cleanupLibrary and the real SQL functions run against a
// local database (packages/db/tests/library/backlog-drill.mjs builds it and sets LIBRARY_DRILL_DB_PORT). Storage is
// the local storage.objects stand-in, so the 0376 write guard is the real trigger. Each simulated 5-minute cron run
// moves every stored time back by 5 minutes, so the guard window, the second absence look and the 24-hour clock
// behave as they would over a day of Pro cron runs. Sizes come from LIBRARY_DRILL_SIZES (default 1000,6000).
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanupLibrary } from './cleanup';
import type { LibraryStorage } from './storage';

const port = Number(process.env.LIBRARY_DRILL_DB_PORT ?? 0);
const BUCKET = 'library-documents';
const RUN_MINUTES = 5;
const DAY_RUNS = 24 * 60 / RUN_MINUTES;
// Rows per cron run: 50 is the cron's batch on staging today; LIBRARY_DRILL_BATCH=100 measures the proposed batch.
const BATCH = Number(process.env.LIBRARY_DRILL_BATCH ?? 50);

type Faults = { down: (run: number) => boolean; rate: number };
type Outcome = {
  documents: number; objectsGoneMinutes: number | null; releasedMinutes: number | null;
  maxOverdue: number; runs: number; failedRows: number; slowestRunMs: number;
};

// PostgREST stand-in: named arguments, service_role, { data, error } like supabase-js.
function rpcClient(service: pg.Client) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const call = `SELECT public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) AS v`;
      try {
        const result = await service.query(call, keys.map(k => args[k]));
        return { data: result.rows[0].v, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    },
  } as unknown as SupabaseClient;
}

// Deterministic pseudo-random failures, so a rerun reproduces the same numbers.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function objectStore(admin: pg.Client, faults: Faults, clock: { run: number }) {
  const random = seeded(7);
  const fault = () => {
    if (faults.down(clock.run) || random() < faults.rate) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
  };
  return {
    async absent(path: string) {
      fault();
      const found = await admin.query('SELECT 1 FROM storage.objects WHERE bucket_id=$1 AND name=$2', [BUCKET, path]);
      return found.rowCount === 0;
    },
    async remove(path: string) {
      fault();
      await admin.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2', [BUCKET, path]);
    },
  } as unknown as LibraryStorage;
}

async function connect() {
  const client = new pg.Client({
    host: '127.0.0.1', port, database: 'libdrill', user: 'postgres', password: 'local-test-only',
  });
  await client.connect();
  return client;
}

// Ready documents whose upload just finished (guard still 3 h 5 min ahead) and whose objects are in storage.
async function seedReady(admin: pg.Client, actors: number, perActor: number, guardMinutes: number) {
  const ids: string[] = [];
  // Seeding writes objects for already-ready documents, which the 0376 guard (rightly) refuses; it is back on below.
  await admin.query('ALTER TABLE storage.objects DISABLE TRIGGER library_storage_write_guard');
  for (let i = 0; i < actors; i++) {
    const actor = randomUUID();
    ids.push(actor);
    await admin.query('INSERT INTO profiles(id) VALUES($1)', [actor]);
    await admin.query(`
      WITH docs AS (
        INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status,original_bytes)
        SELECT $1,gen_random_uuid(),'document','txt','reference','drill.txt','ready',2000
        FROM generate_series(1,$2) RETURNING id
      ), holds AS (
        INSERT INTO library_upload_reservations(document_id,actor_id,original_hold,original_guard_until,original_path)
        SELECT id,$1,2000,clock_timestamp()+make_interval(mins=>$3),$1::text||'/'||id::text||'/original' FROM docs
        RETURNING original_path
      )
      INSERT INTO storage.objects(bucket_id,name,metadata) SELECT $4,original_path,'{"size":2000}' FROM holds`,
    [actor, perActor, guardMinutes, BUCKET]);
  }
  await admin.query('ALTER TABLE storage.objects ENABLE TRIGGER library_storage_write_guard');
  return ids;
}

async function shiftClock(admin: pg.Client) {
  const step = `interval '${RUN_MINUTES} minutes'`;
  await admin.query(`UPDATE library_upload_reservations SET original_guard_until=original_guard_until-${step},
    text_guard_until=text_guard_until-${step},absent_observed_at=absent_observed_at-${step},
    checked_at=checked_at-${step} WHERE cleanup`);
  await admin.query(`UPDATE library_documents SET deleted_at=deleted_at-${step} WHERE deleted_at IS NOT NULL`);
}

async function purge(admin: pg.Client, actors: string[]) {
  await admin.query('DELETE FROM library_document_segments WHERE actor_id=ANY($1)', [actors]);
  await admin.query('DELETE FROM library_recognition_units WHERE actor_id=ANY($1)', [actors]);
  await admin.query('DELETE FROM library_upload_reservations WHERE actor_id=ANY($1)', [actors]);
  await admin.query('DELETE FROM library_documents WHERE actor_id=ANY($1)', [actors]);
  await admin.query("DELETE FROM storage.objects WHERE bucket_id=$1 AND split_part(name,'/',1)=ANY($2)", [BUCKET, actors]);
}

async function drain(actors: string[], faults: Faults, maxRuns = DAY_RUNS + 48): Promise<Outcome> {
  const admin = await connect();
  const service = await connect();
  await service.query('SET ROLE service_role');
  const clock = { run: 0 };
  const client = rpcClient(service);
  const storage = objectStore(admin, faults, clock);
  const scope = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM library_documents WHERE actor_id=ANY($1)) docs,
      (SELECT count(*)::int FROM storage.objects o WHERE bucket_id=$2 AND split_part(o.name,'/',1)=ANY($3)) objects,
      (SELECT count(*)::int FROM library_documents WHERE actor_id=ANY($1)
        AND deleted_at<clock_timestamp()-interval '24 hours') overdue`,
  [actors, BUCKET, actors])).rows[0] as { docs: number; objects: number; overdue: number };
  const documents = (await scope()).docs;
  const queued = await admin.query(
    'SELECT count(*)::int n FROM library_upload_reservations WHERE cleanup AND NOT actor_id=ANY($1)', [actors]);
  expect(queued.rows[0].n, 'an earlier scenario left rows in the cleanup queue').toBe(0);
  // The user deletes everything at once and every inline Storage removal fails: all objects stay for the cron.
  for (const actor of actors) {
    const docs = await admin.query('SELECT id FROM library_documents WHERE actor_id=$1', [actor]);
    for (const row of docs.rows) await service.query('SELECT library_delete($1,$2)', [actor, row.id]);
  }
  const outcome: Outcome = {
    documents, objectsGoneMinutes: null, releasedMinutes: null, maxOverdue: 0, runs: 0, failedRows: 0, slowestRunMs: 0,
  };
  try {
    while (clock.run < maxRuns) {
      clock.run++;
      await shiftClock(admin);
      const started = Date.now();
      const result = await cleanupLibrary(client, { storage, limit: BATCH });
      outcome.slowestRunMs = Math.max(outcome.slowestRunMs, Date.now() - started);
      outcome.failedRows += result.failed;
      const now = await scope();
      outcome.maxOverdue = Math.max(outcome.maxOverdue, now.overdue);
      const minutes = clock.run * RUN_MINUTES;
      if (now.objects === 0 && outcome.objectsGoneMinutes === null) outcome.objectsGoneMinutes = minutes;
      if (now.docs === 0) { outcome.releasedMinutes = minutes; break; }
    }
    outcome.runs = clock.run;
    return outcome;
  } finally {
    // A scenario that does not drain (8000) must not leave its backlog in the queue the next scenario measures.
    await purge(admin, actors);
    await admin.end();
    await service.end();
  }
}

const hours = (minutes: number | null) => minutes === null ? 'not within the window' : `${(minutes / 60).toFixed(2)} h`;
// Vitest hides passing tests' console output, so results also go to LIBRARY_DRILL_OUT when it is set.
function record(name: string, value: object) {
  const line = `[backlog-drill] ${name}: ${JSON.stringify(value)}\n`;
  process.stdout.write(line);
  if (process.env.LIBRARY_DRILL_OUT) appendFileSync(process.env.LIBRARY_DRILL_OUT, line);
}
function report(name: string, outcome: Outcome) {
  record(name, { ...outcome, objectsGone: hours(outcome.objectsGoneMinutes), released: hours(outcome.releasedMinutes) });
}

describe.skipIf(!port)('library cleanup backlog drill (local database)', () => {
  const sizes = (process.env.LIBRARY_DRILL_SIZES ?? '1000,6000').split(',').map(Number);
  const background = Number(process.env.LIBRARY_DRILL_BACKGROUND ?? 20000);

  it('starts from an empty cleanup queue, so each scenario measures only its own backlog', async () => {
    const admin = await connect();
    const pending = await admin.query('SELECT count(*)::int n FROM library_upload_reservations WHERE cleanup');
    expect(pending.rows[0].n).toBe(0);
    await admin.end();
  });

  it('seeds untouched documents so every candidate query scans a realistic table', async () => {
    const admin = await connect();
    await seedReady(admin, Math.ceil(background / 5000), Math.min(background, 5000), -60);
    await admin.query('SET ROLE service_role');
    const timed = async (call: string) => {
      const started = Date.now();
      await admin.query(call);
      return Date.now() - started;
    };
    await timed('SELECT public.library_cleanup_candidates(NULL,50,NULL)');
    record('live table', { live: background,
      candidatesMs: await timed('SELECT public.library_cleanup_candidates(NULL,50,NULL)'),
      backlogMs: await timed('SELECT public.library_cleanup_backlog(NULL)') });
    await admin.end();
  }, 600_000);

  for (const size of sizes) {
    it(`burst of ${size} deletions, every inline Storage removal failed`, async () => {
      const admin = await connect();
      const actors = await seedReady(admin, Math.ceil(size / 100), Math.min(size, 100), 185);
      await admin.end();
      const outcome = await drain(actors, { down: () => false, rate: 0 });
      report(`burst ${size}`, outcome);
      expect(outcome.objectsGoneMinutes).not.toBeNull();
      if (outcome.releasedMinutes !== null && outcome.releasedMinutes <= 24 * 60) expect(outcome.maxOverdue).toBe(0);
    }, 3_600_000);
  }

  it('Storage down for 8 hours, then 10% of calls fail', async () => {
    const admin = await connect();
    const actors = await seedReady(admin, 30, 100, 185);
    await admin.end();
    const outcome = await drain(actors, { down: run => run <= 8 * 60 / RUN_MINUTES, rate: 0.1 });
    report('outage 3000', outcome);
    expect(outcome.failedRows).toBeGreaterThan(0);
    expect(outcome.releasedMinutes).not.toBeNull();
    expect(outcome.releasedMinutes!).toBeLessThanOrEqual(24 * 60);
    expect(outcome.maxOverdue).toBe(0);
  }, 3_600_000);

  it('late signed writes: refused after deletion, earlier ones removed by the cron', async () => {
    const admin = await connect();
    const service = await connect();
    await service.query('SET ROLE service_role');
    await admin.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
    await admin.query("UPDATE membership_plans SET library_storage_bytes=2000000000 WHERE level='free'");
    const actor = randomUUID();
    await admin.query('INSERT INTO profiles(id) VALUES($1)', [actor]);
    const grants = [];
    for (let i = 0; i < 4; i++) {
      grants.push((await service.query("SELECT library_upload_begin($1,$2,'late.txt','txt','reference',5) v",
        [actor, randomUUID()])).rows[0].v as { documentId: string; path: string });
    }
    const put = (path: string) => admin.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)',
      [BUCKET, path, { size: 5 }]);
    // Two writes land while the upload is still open (the browser was slow), then the user deletes all four.
    await put(grants[0]!.path);
    await put(grants[1]!.path);
    for (const grant of grants) await service.query('SELECT library_delete($1,$2)', [actor, grant.documentId]);
    for (const grant of grants.slice(2)) {
      await expect(put(grant.path)).rejects.toMatchObject({ code: '42501' });
    }
    await admin.end();
    await service.end();
    const outcome = await drain([actor], { down: () => false, rate: 0 });
    report('late writes', outcome);
    expect(outcome.releasedMinutes).not.toBeNull();
    // After release no reservation claims the path, so the old token still cannot write.
    const after = await connect();
    await expect(after.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)',
      [BUCKET, grants[0]!.path, { size: 5 }])).rejects.toMatchObject({ code: '42501' });
    await after.end();
  }, 600_000);
});
