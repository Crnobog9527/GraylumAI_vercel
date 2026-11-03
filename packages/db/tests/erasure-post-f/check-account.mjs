/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Read-only erasure re-check for one erased test account (CORE-PATH-V2 batch F follow-up). The SQL is audit-account.sql: one SELECT, counts only.
// CI uses buildAuditSql() against the local disposable database (run-local.mjs). The staging run is manual, after batch F is on staging:
//   node packages/db/tests/erasure-post-f/check-account.mjs --profile <uuid> --complete --post-f --workdir <scratch dir linked to staging>
// Options: --save-baseline <file> (before the erasure: remember the billing records) / --compare <file> (after: they must be unchanged),
//          --print-sql (print the SQL instead of running it). Refuses any project that is not the staging project.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const STAGING_REF = 'gvcpmcunmfrbxuwimxfa';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEPT = ['turns_billing_record_kept', 'turn_calls_billing_record_kept', 'credit_transactions_kept'];

export function buildAuditSql({ profileId, complete = false, postF = false }) {
  if (!UUID.test(String(profileId))) throw new Error('profile id must be a lower-case uuid');
  const template = readFileSync(resolve(import.meta.dirname, 'audit-account.sql'), 'utf8');
  return template.replaceAll('__PROFILE_ID__', profileId).replaceAll('__COMPLETE__', complete ? 'true' : 'false')
    .replaceAll('__POST_F__', postF ? 'true' : 'false');
}

export const failures = rows => rows.filter(r => r.ok === false || r.ok === 'false' || r.ok === 'f');

export function format(rows) {
  const width = Math.max(...rows.map(r => `${r.section}/${r.check_name}`.length));
  return rows.map(r => `${r.ok === true || r.ok === 'true' ? 'ok  ' : 'FAIL'} ${`${r.section}/${r.check_name}`.padEnd(width)} expect ${String(r.expect).padEnd(4)} actual ${r.actual}`).join('\n');
}

export const baselineOf = rows => Object.fromEntries(rows.filter(r => KEPT.includes(r.check_name)).map(r => [r.check_name, Number(r.actual)]));

function runStaging(sql, workdir) {
  const refFile = resolve(workdir, 'supabase/.temp/project-ref');
  if (!existsSync(refFile) || readFileSync(refFile, 'utf8').trim() !== STAGING_REF) throw new Error('workdir is not linked to the staging project');
  // The SQL starts with a comment line, so it goes in as a file: as an argument the CLI would read it as an option.
  const dir = mkdtempSync(resolve(tmpdir(), 'erasure-audit-'));
  const file = resolve(dir, 'audit.sql');
  writeFileSync(file, sql);
  let r;
  try { r = spawnSync('supabase', ['db', 'query', '--linked', '--workdir', workdir, '-o', 'json', '-f', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(-2000));
  const out = JSON.parse(r.stdout);
  const rows = Array.isArray(out) ? out : out.rows;
  if (!Array.isArray(rows)) throw new Error(`unexpected supabase output keys: ${Object.keys(out)}`);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const sql = buildAuditSql({ profileId: value('--profile'), complete: args.includes('--complete'), postF: args.includes('--post-f') });
  if (args.includes('--print-sql')) { console.log(sql); process.exit(0); }
  const workdir = value('--workdir');
  if (!workdir) throw new Error('--workdir <scratch dir linked to the staging project> is required');
  const rows = runStaging(sql, resolve(workdir));
  console.log(format(rows));
  const problems = failures(rows).map(r => `${r.section}/${r.check_name}`);
  if (value('--save-baseline')) writeFileSync(resolve(value('--save-baseline')), JSON.stringify(baselineOf(rows), null, 1) + '\n');
  if (value('--compare')) {
    const before = JSON.parse(readFileSync(resolve(value('--compare')), 'utf8')), after = baselineOf(rows);
    for (const k of KEPT) if (before[k] !== after[k]) problems.push(`billing record changed: ${k} ${before[k]} -> ${after[k]}`);
  }
  console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nall checks passed');
  process.exitCode = problems.length ? 1 : 0;
}
