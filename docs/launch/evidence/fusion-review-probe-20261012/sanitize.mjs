#!/usr/bin/env node
// 提交前清理 runs/*.json 里的账号标识（user_id、workspace_id、request_id 等）。仓库是公开的。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = join(dirname(fileURLToPath(import.meta.url)), 'runs');
const KEYS = new Set(['user_id', 'workspace_id', 'request_id', 'session_id', 'external_user', 'app_id']);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, KEYS.has(k) && x ? '<redacted>' : scrub(x)]));
  }
  return v;
}

for (const f of readdirSync(RUNS).filter((n) => n.endsWith('.json'))) {
  const p = join(RUNS, f);
  writeFileSync(p, `${JSON.stringify(scrub(JSON.parse(readFileSync(p, 'utf8'))), null, 2)}\n`);
}
