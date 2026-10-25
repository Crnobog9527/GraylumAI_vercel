import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA_KEYS } from './envValidator';

const REPO_ROOT = join(__dirname, '../../../..');
const ROOTS = ['apps/web', 'packages/api/src', 'packages/db'];
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'tests', '__tests__', 'e2e', 'migrations', 'scripts', '.turbo', 'test-results']);
const SKIP_FILE = /\.(test|spec|integration|browser)\.|playwright|\.d\.ts$/;
const SOURCE = /\.(ts|tsx|mjs|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(full, out);
    } else if (SOURCE.test(name) && !SKIP_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('environment variable schema coverage', () => {
  it('every process.env.X read by production code is declared in envValidator', () => {
    const declared = new Set(ENV_SCHEMA_KEYS);
    const missing = new Map<string, string>();
    for (const root of ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        for (const [, name] of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          if (!declared.has(name) && !missing.has(name)) missing.set(name, relative(REPO_ROOT, file));
        }
      }
    }
    expect([...missing].map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });
});
