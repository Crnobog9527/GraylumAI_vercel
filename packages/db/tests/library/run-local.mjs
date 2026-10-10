/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const name = `graylum-lib2a-${randomUUID().slice(0, 8)}`;
const command = (argv, input) => {
  const r = spawnSync('docker', argv, { input, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(r.stderr || String(r.error));
  return r.stdout.trim();
};
const endpoint = command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.ok(endpoint.startsWith('unix:///'));
const docker = (argv, input) => command(['--host', endpoint, ...argv], input);
const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'lib2a',
  '-v', 'ON_ERROR_STOP=1', '-f', '/dev/stdin'], input);
let clients = [];
try {
  docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-test-only', '-e', 'POSTGRES_DB=lib2a',
    '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); break; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  installPgCronStub(root, name, (argv, input) => docker(['exec', ...argv], input));
  const apply = input => { try { sql(input); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  const report = buildFromFiles(root, {
    applyFile: path => apply(readFileSync(resolve(root, path), 'utf8')), applyServerOnly: apply,
  });
  assert.equal(report.failed, null, JSON.stringify(report));
  // Repeat new migration at its own position; the baseline replay command additionally compares structure.
  sql(readFileSync(resolve(root, 'packages/db/migrations/0203_library_documents.sql'), 'utf8'));
  const port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
  const connect = async () => {
    const c = new pg.Client({ host: '127.0.0.1', port, database: 'lib2a', user: 'postgres', password: 'local-test-only' });
    clients.push(c); await c.connect(); return c;
  };
  const admin = await connect(); const one = await connect(); const two = await connect();
  const a = randomUUID(); const b = randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1),($2)', [a,b]);
  await admin.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES('Free','free',false,false,50000000),('Pro','pro',true,true,500000000),('Gold','gold',true,true,2000000000)
    ON CONFLICT(level) DO NOTHING`);
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const begin = (c, actor, request = randomUUID()) => c.query(
    "SELECT library_upload_begin($1,$2,'file.txt','txt','reference',1) AS value", [actor, request]);
  const expectError = async (fn, message) => {
    await assert.rejects(fn, e => e.message.includes(message));
  };
  await expectError(() => begin(one,a), 'LIBRARY_DISABLED');
  await admin.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
  await admin.query("UPDATE membership_plans SET library_storage_bytes=15000000 WHERE level='free'");
  // Real independent connections + explicit lock barrier, not Promise timing as a proxy for overlap.
  await admin.query('BEGIN'); await admin.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[a]);
  const first = begin(one,a); const second = begin(two,a);
  let blocked = false;
  for(let i=0;i<100;i++) {
    const wait = await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT library_upload_begin%'");
    if(wait.rows[0].n===2) {blocked=true;break;}
    await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(blocked, 'both admissions must wait on the profile barrier');
  await admin.query('COMMIT');
  const admissions=await Promise.allSettled([first,second]);
  assert.equal(admissions.filter(r=>r.status==='fulfilled').length,1, admissions.map(r=>r.reason?.message).join('; '));
  assert.match(admissions.find(r=>r.status==='rejected').reason.message,/LIBRARY_SPACE/);
  const doc=admissions.find(r=>r.status==='fulfilled').value.rows[0].value.documentId;
  assert.equal((await admin.query('SELECT sum(original_hold) AS n FROM library_upload_reservations WHERE actor_id=$1',[a])).rows[0].n,'10000000');
  const originalPath=`${a}/${doc}/original`;
  const claimed=(await one.query('SELECT library_paths_claimed($1) AS paths',[[originalPath,`${a}/${randomUUID()}/original`]])).rows[0].paths;
  assert.deepEqual(claimed,[originalPath]);
  const request=(await admin.query('SELECT request_id FROM library_documents WHERE id=$1',[doc])).rows[0].request_id;
  assert.equal((await begin(one,a,request)).rows[0].value.dispatch,false);
  await expectError(()=>one.query('SELECT library_document_read($1,$2,false)',[b,doc]),'LIBRARY_NOT_FOUND');
  await expectError(()=>one.query('SELECT library_publish($1,$2,10000001,$3)',[a,doc,'[]']),'LIBRARY_INVALID');
  await one.query('SELECT library_publish($1,$2,5,$3)',[a,doc,JSON.stringify([{title:'',body:'hello'}])]);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=1 WHERE level='free'");
  assert.equal((await one.query('SELECT library_document_read($1,$2) AS value',[a,doc])).rows[0].value.status,'ready');
  await expectError(()=>begin(one,a),'LIBRARY_SPACE');
  await one.query('SELECT library_delete($1,$2)',[a,doc]);
  assert.equal((await admin.query('SELECT filename FROM library_documents WHERE id=$1',[doc])).rows[0].filename,null);
  assert.equal((await admin.query('SELECT count(*) AS n FROM library_document_segments WHERE document_id=$1',[doc])).rows[0].n,'0');
  await expectError(()=>one.query('SELECT library_document_read($1,$2)',[a,doc]),'LIBRARY_NOT_FOUND');
  await expectError(()=>one.query('SELECT library_publish($1,$2,5,$3)',[a,doc,'[]']),'LIBRARY_NOT_FOUND');
  // Neither an empty prefix nor a failed removal releases a live token's reservation.
  assert.equal((await one.query('SELECT library_cleanup_observe($1,$2,true) AS done',[a,doc])).rows[0].done,false);
  assert.ok(Number((await one.query('SELECT library_erasure_remaining($1) AS n',[a])).rows[0].n)>0);
  await admin.query("UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute' WHERE document_id=$1",[doc]);
  await one.query('SELECT library_cleanup_observe($1,$2,true)',[a,doc]);
  await one.query('SELECT library_cleanup_observe($1,$2,false)',[a,doc]);
  assert.equal((await admin.query('SELECT absent_observed_at FROM library_upload_reservations WHERE document_id=$1',[doc])).rows[0].absent_observed_at,null);
  await one.query('SELECT library_cleanup_observe($1,$2,true)',[a,doc]);
  await new Promise(r=>setTimeout(r,1050));
  assert.equal((await one.query('SELECT library_cleanup_observe($1,$2,true) AS done',[a,doc])).rows[0].done,true);
  assert.equal((await one.query('SELECT library_erasure_remaining($1) AS n',[a])).rows[0].n,'0');
  await one.query('SELECT library_delete($1,$2)',[a,doc]);
  // Privileges: raw tables and helper functions forbidden, RPCs unavailable to anonymous/authenticated roles.
  for(const role of ['anon','authenticated']) {
    await two.query(`SET ROLE ${role}`);
    await expectError(()=>begin(two,b),'permission denied');
    await expectError(()=>two.query('SELECT * FROM library_documents'),'permission denied');
  }
  await two.query('SET ROLE service_role');
  await expectError(()=>two.query('SELECT * FROM library_upload_reservations'),'permission denied');
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  // Membership plan remains the authority, including administrator-granted levels.
  for (const [level,capacity] of [['free',50000000],['pro',500000000],['gold',2000000000]]) {
    await admin.query('UPDATE profiles SET membership_level=$2 WHERE id=$1',[a,level]);
    const listed=(await one.query('SELECT library_list($1) AS value',[a])).rows[0].value;
    assert.equal(listed.capacityBytes,capacity);
  }
  await admin.query("UPDATE profiles SET membership_level='free' WHERE id=$1",[a]);
  for(let i=0;i<4;i++) await begin(one,a);
  await expectError(()=>begin(one,a),'LIBRARY_INFLIGHT_LIMIT');
  // Existing admitted image can finish without enlarging its reservation after downgrade.
  const image=(await one.query("SELECT library_upload_begin($1,$2,'a.png','png','reference',8) AS value",[b,randomUUID()])).rows[0].value;
  await admin.query("UPDATE membership_plans SET library_storage_bytes=1 WHERE level='free'");
  await one.query('SELECT library_publish($1,$2,8,$3)',[b,image.documentId,'[]']);
  await one.query('SELECT library_delete($1,$2,false,true)',[b,image.documentId]);
  assert.equal((await one.query('SELECT library_document_read($1,$2) AS value',[b,image.documentId])).rows[0].value.status,'ready');
  await admin.query("UPDATE membership_plans SET library_storage_bytes=50000000 WHERE level='free'");
  // Disabled/banned are reversible access states, never erasure requests.
  await admin.query("UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute' WHERE document_id=$1",[image.documentId]);
  for(const state of ['disabled','banned']) {
    await admin.query('UPDATE profiles SET status=$2 WHERE id=$1',[b,state]);
    await expectError(()=>one.query('SELECT library_document_read($1,$2)',[b,image.documentId]),'LIBRARY_ACCOUNT_CLOSED');
    const candidates=(await one.query('SELECT library_cleanup_candidates($1) AS value',[b])).rows[0].value;
    assert.ok(candidates.every(row=>row.closed===false));
    assert.equal((await one.query('SELECT library_cleanup_backlog($1) AS value',[b])).rows[0].value.pending,0);
  }
  await admin.query("UPDATE profiles SET status='active' WHERE id=$1",[b]);
  assert.equal((await one.query('SELECT library_document_read($1,$2) AS value',[b,image.documentId])).rows[0].value.status,'ready');
  // Deterministic stale-candidate race: observe expiry, then publication commits, then cleanup takes its lock.
  const racing=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[racing]);
  const raceDoc=(await begin(one,racing)).rows[0].value.documentId;
  assert.equal((await one.query('SELECT library_delete($1,$2,true,true,true) AS value',
    [racing,raceDoc])).rows[0].value.status,'uploading');
  await admin.query("UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute' WHERE document_id=$1",[raceDoc]);
  const stale=(await one.query('SELECT library_cleanup_candidates($1) AS value',[racing])).rows[0].value;
  assert.equal(stale[0].status,'uploading');
  await two.query('SELECT library_publish($1,$2,5,$3)',[racing,raceDoc,JSON.stringify([{title:'',body:'hello'}])]);
  assert.equal((await one.query('SELECT library_delete($1,$2,true,true,true) AS value',[racing,raceDoc])).rows[0].value.status,'ready');
  assert.equal((await one.query('SELECT library_segments($1,$2,1) AS value',[racing,raceDoc])).rows[0].value[0].body,'hello');
  // File-count protection is independent of membership; deleted shells still consume a slot until cleaned.
  const many=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[many]);
  await admin.query(`INSERT INTO library_documents(actor_id,request_id,kind,status)
    SELECT $1,gen_random_uuid(),'document','deleting' FROM generate_series(1,10000)`,[many]);
  await expectError(()=>begin(one,many),'LIBRARY_FILE_LIMIT');
  // Ticket upload admission/finish regression remains untouched.
  const ticket=randomUUID();
  await one.query('SELECT ticket_upload_begin($1,$2)',[b,ticket]);
  await one.query('SELECT ticket_upload_finish($1,$2,true)',[b,ticket]);
  await admin.query("UPDATE profiles SET status='suspended' WHERE id=$1",[b]);
  await expectError(()=>begin(one,b),'LIBRARY_ACCOUNT_CLOSED');
  const buckets=(await admin.query("SELECT id,public,file_size_limit FROM storage.buckets WHERE id IN ('ticket-attachments','library-documents')")).rows;
  assert.equal(buckets.length,2); assert.ok(buckets.every(b=>b.public===false));
  assert.equal(Number(buckets.find(b=>b.id==='library-documents').file_size_limit),10000000);
  assert.equal((await admin.query("SELECT count(*) AS n FROM pg_policies WHERE schemaname='storage'")).rows[0].n,'0');
  console.log(JSON.stringify({result:'PASS',steps:report.passed,newMigrationRepeated:true,
    cases:['default-off','concurrent-quota-barrier','idempotent-no-new-token','cross-user-denial','actual-size',
      'atomic-publication','downgrade-read-delete','delete-private-fields','delete-publish-denial','live-token-hold',
      'late-object-resets-proof','two-absence-release','domain-erasure-proof','anonymous-authenticated-denied',
      'raw-service-table-denied','disabled-banned-retention','stale-expiry-publication','live-expiry-recheck','ticket-upload-regression','closed-account','private-bucket-policy']}));
  console.log('NOT_RUN: shared erasure completion/two-bucket restart (#766 dependency); real Storage; final post-dependency fingerprint');
} finally {
  await Promise.all(clients.map(c=>c.end()));
  try {docker(['rm','-f',name]);} catch { /* preserve original failure */ }
}
