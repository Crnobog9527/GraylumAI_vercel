/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Staging-only read checks. Project settings are not evidence of a deployment's runtime binding.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC';
const TEAM = 'team_O4u4PnUCzCRftUxLVgYBGrgB';
const REF = 'gvcpmcunmfrbxuwimxfa';
const HOST = 'auth-staging.graylum.com';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const validateOnly = argv.length === 3 && argv[2] === '--validate-only';
const workdir = (argv.length === 2 || validateOnly) && argv[0] === '--staging-workdir' ? argv[1] : '';
let valid = false, pooler;
try {
  const ref = readFileSync(resolve(workdir, 'supabase/.temp/project-ref'), 'utf8').trim();
  const raw = readFileSync(resolve(workdir, 'supabase/.temp/pooler-url'), 'utf8').trim();
  const url = new URL(raw);
  valid = !!workdir && ref === REF && url.protocol === 'postgresql:' && url.username === `postgres.${REF}`
    && !url.password && url.hostname.endsWith('.pooler.supabase.com') && !url.search && !url.hash && url.pathname === '/postgres';
  if (valid) pooler = raw;
} catch { /* missing or invalid */ }
if (!valid) { console.log('staging-target: failed (missing or wrong linked project)'); process.exit(1); }
console.log('staging-target: passed (approved project link)');
if (validateOnly) process.exit(0);
function api(path) {
  const child = spawnSync('vercel', ['api', path, '--non-interactive'], { encoding: 'utf8', timeout: 60_000 });
  if (child.error || child.status !== 0) return null;
  try { return JSON.parse(child.stdout); } catch { return null; }
}
const project = api(`/v9/projects/${PROJECT}?teamId=${TEAM}`);
const projectOk = project?.id === PROJECT && project?.name === 'graylumai-staging';
console.log(`deployment-project: ${projectOk ? 'passed' : 'failed'}${projectOk ? '' : ' (unavailable or mismatch)'}`);
let deploymentOk = false, versionOk = false;
if (projectOk) {
  const deployment = api(`/v13/deployments/${HOST}?teamId=${TEAM}&withGitRepoInfo=true`);
  deploymentOk = (deployment?.projectId ?? deployment?.project?.id) === PROJECT && deployment?.readyState === 'READY'
    && deployment?.meta?.githubCommitRef === 'staging';
  console.log(`deployment-identity: ${deploymentOk ? 'passed' : 'failed'}${deploymentOk ? '' : ' (unavailable or mismatch)'}`);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const changes = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  versionOk = deploymentOk && revision.status === 0 && changes.status === 0 && changes.stdout.trim() === ''
    && deployment?.meta?.githubCommitSha === revision.stdout.trim();
  console.log(`deployment-version: ${versionOk ? 'passed' : 'failed'}${versionOk ? '' : ' (not this checkout version)'}`);
} else {
  console.log('deployment-identity: not-run (project check failed)');
  console.log('deployment-version: not-run (project check failed)');
}
const sql = resolve(root, 'scripts/release-staging-maintenance.sql');
let maintenanceOk = false;
const privateWorkdir = mkdtempSync(resolve(tmpdir(), 'graylum-staging-ro-'));
try {
  const temp = resolve(privateWorkdir, 'supabase/.temp');
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(temp, 'project-ref'), REF + '\n', { mode: 0o600 });
  writeFileSync(resolve(temp, 'pooler-url'), pooler, { mode: 0o600 });
  const query = spawnSync('supabase', ['db', 'query', '--linked', '--workdir', privateWorkdir, '-f', sql, '-o', 'json'],
    { encoding: 'utf8', timeout: 60_000 });
  try {
    const rows = JSON.parse(query.stdout).rows;
    maintenanceOk = query.status === 0 && rows.length === 1 && (rows[0].value === false || rows[0].value === 'false');
  } catch { /* missing or malformed output */ }
} finally { rmSync(privateWorkdir, { recursive: true, force: true }); }
console.log(`staging-maintenance: ${maintenanceOk ? 'passed' : 'failed'}${maintenanceOk ? '' : ' (enabled, missing, or unavailable)'}`);
// Vercel's deployment detail endpoint does not expose the deployed runtime values. Do not substitute current project values.
console.log('runtime-binding: not-run (authoritative deployment runtime evidence unavailable)');
process.exit(1);
