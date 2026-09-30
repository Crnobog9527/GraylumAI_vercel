/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Runs run-db-baseline-replay.mjs for a branch that adds migrations not yet applied to staging.
// The staging fingerprint cannot contain them, so this wrapper:
//   1. builds without the new migrations (moved aside next to migrations/, always restored)
//      -> structure "before";
//   2. builds with them -> structure "after";
//   3. overlays exactly the before->after differences onto staging-fingerprint.json;
//   4. replays again against that overlay with --after <checks>, so every other staging
//      difference is still judged by baseline/expected-differences.json as usual.
// Usage: node packages/db/tests/baseline/replay-with-new-migrations.mjs --local-only
//          --new 0149_x.sql[,0150_y.sql] [--after a.sql,b.sql] [--before-after c.sql]
// --before-after runs checks on the build WITHOUT the new migrations (e.g. a structure fingerprint).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] !== '--local-only' || !option('--new') || process.env.CI) {
  throw new Error('Usage: node packages/db/tests/baseline/replay-with-new-migrations.mjs --local-only'
    + ' --new <migration.sql,...> [--after <a.sql,b.sql>] [--before-after <c.sql>]');
}
const root = resolve(import.meta.dirname, '../../../..');
const migrations = resolve(root, 'packages/db/migrations');
const holdDir = resolve(root, 'packages/db');
const HOLD_PREFIX = '.replay-held-';
// A previous run that died between hold and restore leaves '.replay-held-<file>' behind: put it
// back when the migration is missing, refuse to guess when both copies exist.
for (const leftover of readdirSync(holdDir).filter(name => name.startsWith(HOLD_PREFIX))) {
  const original = resolve(migrations, leftover.slice(HOLD_PREFIX.length));
  if (existsSync(original)) throw new Error(`Both ${original} and packages/db/${leftover} exist; resolve by hand`);
  renameSync(resolve(holdDir, leftover), original);
  console.error(`Restored leftover ${leftover} from an interrupted run`);
}
const newFiles = option('--new').split(',');
for (const file of newFiles) {
  if (!/^\d{4}_[A-Za-z0-9._-]+\.sql$/.test(file) || !existsSync(resolve(migrations, file))) {
    throw new Error(`Not a migration in packages/db/migrations: ${file}`);
  }
}
const temp = mkdtempSync(resolve(tmpdir(), 'graylum-new-migrations-'));
const replay = extra => {
  const result = spawnSync('node', ['packages/db/tests/run-db-baseline-replay.mjs', '--local-only', ...extra], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error(`Replay printed no report: ${(result.stderr || '').slice(0, 2000)}`);
  return JSON.parse(result.stdout.slice(start));
};

const summary = { newMigrations: newFiles };
try {
  const before = resolve(temp, 'before.json');
  const after = resolve(temp, 'after.json');
  const overlay = resolve(temp, 'overlay.json');
  // Held on the same volume as the checkout (rename across devices fails), outside migrations/.
  const held = newFiles.map(file => [resolve(migrations, file), resolve(holdDir, `${HOLD_PREFIX}${file}`)]);
  const restore = () => {
    for (const [from, to] of held) if (existsSync(to) && !existsSync(from)) renameSync(to, from);
  };
  // The replay runs synchronously: a terminal Ctrl+C also stops that child, the run then throws and
  // `finally` restores. The handlers cover a signal that arrives outside the synchronous replay.
  const onSignal = signal => { restore(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (const [from, to] of held) renameSync(from, to);
    const base = replay(['--out', before, ...(option('--before-after') ? ['--after', option('--before-after')] : [])]);
    summary.before = base.after;
    if (base.failed) throw new Error(`Build without the new migrations failed: ${JSON.stringify(base.failed)}`);
  } finally {
    restore();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  const built = replay(['--out', after]);
  if (built.failed?.step !== 'staging comparison' && built.failed) {
    throw new Error(`Build with the new migrations failed: ${JSON.stringify(built.failed)}`);
  }
  const pre = JSON.parse(readFileSync(before, 'utf8'));
  const post = JSON.parse(readFileSync(after, 'utf8'));
  const snapshot = JSON.parse(readFileSync(resolve(root, 'packages/db/tests/baseline/staging-fingerprint.json'), 'utf8'));
  const objectValue = (key, value) => /^(acl|defacl):/.test(key) ? value
    : createHash('md5').update(value ?? '<null>').digest('hex').slice(0, 12);
  // The staging snapshot stores individual objects only for differing groups. Hydrate an
  // affected matching group from the before-build: its exact group hash proves those objects.
  // Differing groups keep staging's original objects and all their expected differences.
  for (const key of Object.keys(pre.groups)) {
    if (pre.groups[key] === post.groups[key] || !snapshot.groups[key]
      || !pre.groups[key].startsWith(snapshot.groups[key])) continue;
    for (const [item, value] of Object.entries(pre.objects)) {
      if (item.split('.')[0] === key) snapshot.objects[item] = objectValue(item, value);
    }
  }
  let changed = 0;
  for (const part of ['groups', 'objects']) {
    for (const key of new Set([...Object.keys(pre[part]), ...Object.keys(post[part])])) {
      if (pre[part][key] === post[part][key]) continue;
      changed += 1;
      if (key in post[part]) {
        // A changed group can still contain unchanged file-only objects. Never copy its local
        // group hash: that would skip those objects and make a valid expected difference stale.
        // Force the replay's object comparison; snapshot objects use hashes except ACL text.
        snapshot[part][key] = part === 'groups' ? 'compare-overlaid-objects'
          : objectValue(key, post[part][key]);
      }
      else delete snapshot[part][key];
    }
  }
  writeFileSync(overlay, JSON.stringify(snapshot));
  summary.overlaidKeys = changed;
  const report = replay(['--staging', overlay, ...(option('--after') ? ['--after', option('--after')] : [])]);
  Object.assign(summary, {
    failed: report.failed ?? null, unexpected: report.comparison?.unexpected ?? [],
    accountOpenAudit: report.accountOpenAudit, after: report.after, cleanup: report.cleanup,
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 1));
}
if (summary.failed || summary.cleanup !== 'PASS' || summary.unexpected?.length) process.exitCode = 1;
