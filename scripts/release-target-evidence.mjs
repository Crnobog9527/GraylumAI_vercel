/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline consistency check only. The caller must establish the source and authenticity separately.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT = 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC';
const REF = 'gvcpmcunmfrbxuwimxfa';
const HOST = `${REF}.supabase.co`;
export function checkEvidence(data) {
  if (!data || typeof data !== 'object') return 'evidence missing';
  const { deployment, runtime, database } = data;
  if (!deployment || !runtime || !database) return 'evidence incomplete';
  if (deployment.projectId !== PROJECT || deployment.hostname !== 'auth-staging.graylum.com' ||
      deployment.branch !== 'staging' || deployment.state !== 'READY' ||
      !/^dpl_[A-Za-z0-9]+$/.test(deployment.id ?? '') || !/^[a-f0-9]{40}$/.test(deployment.commit ?? '')) {
    return 'deployment target invalid';
  }
  if (runtime.deploymentId !== deployment.id || runtime.commit !== deployment.commit ||
      runtime.supabaseUrl !== `https://${HOST}` || runtime.turnDatabaseHost !== HOST ||
      typeof runtime.source !== 'string' || !runtime.source.trim()) return 'runtime binding missing or mismatched';
  if (database.projectRef !== REF || database.maintenance !== false ||
      typeof database.source !== 'string' || !database.source.trim()) return 'database evidence missing, wrong, or in maintenance';
  return null;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/release-target-evidence.mjs <evidence.json>');
    const error = checkEvidence(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    if (error) throw new Error(error);
    console.log('Fields are consistent. Source authenticity and freshness have not been verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
