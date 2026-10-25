import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// MAINT-P6: the pre-decision conversion values (1 USD = 1000 credits, multiplier 1.5) must not come back in production
// code or seeds. q and m come from the system_settings rows (BILL-UNIT), with BILLING_CONSTANTS as the only code default.
const REPO_ROOT = join(__dirname, '../../../..');
const ROOTS = ['apps/web/src', 'packages/api/src', 'packages/db/seeds'];
const SKIP_DIR = new Set(['node_modules', '.next', 'tests', '__tests__', 'e2e']);
const SKIP_FILE = /\.(test|spec|integration|browser)\.|\.d\.ts$/;
const LEGACY = [
  /creditsPerUsd['"]?\s*[:=]\s*['"]?1000\b/,
  /CREDITS_PER_USD['"]?\s*[:=]\s*1000\b/,
  /(?:multiplier|MULTIPLIER)['"]?\s*[:=]\s*['"]?1\.5\b/,
  /billing_credits_per_usd'\s*,\s*'1000'/,
  /billing_token_price_multiplier'\s*,\s*'1\.5'/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (!SKIP_DIR.has(name)) walk(full, out); }
    else if (/\.(ts|tsx|mjs|sql)$/.test(name) && !SKIP_FILE.test(name)) out.push(full);
  }
  return out;
}

describe('legacy credit conversion values', () => {
  it('1000 credits per USD and multiplier 1.5 do not appear in production code or seeds', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (LEGACY.some(re => re.test(line))) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
