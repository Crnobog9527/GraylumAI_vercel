import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentRemaining, ERASURE_CONTENT_TABLES } from './processorContracts';

const MIGRATIONS = resolve(__dirname, '../../../../db/migrations');

/** Count keys appended by the account scrub RPCs: `counts := counts || jsonb_build_object('<key>', n)`. */
function scrubKeysFromMigrations(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(/counts\s*:=\s*counts\s*\|\|\s*jsonb_build_object\(\s*'([a-z_]+)'/g)) {
      const key = match[1]!.replace(/_skipped$/, '');
      if (!keys.has(key)) keys.set(key, file);
    }
  }
  return keys;
}

describe('account scrub result contract', () => {
  it('accepts the R9 opc_data_events count (0209), which stopped every erasure on staging', () => {
    expect(contentRemaining({ opc_items: 0, research_operations_skipped: 0, opc_data_events: 3 }))
      .toEqual({ remaining: 0, retry: false });
  });

  it('knows every count key a migration adds to the scrub result', () => {
    const keys = scrubKeysFromMigrations();
    expect(keys.size).toBeGreaterThan(30);
    const missing = [...keys].filter(([key]) => !ERASURE_CONTENT_TABLES.has(key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('still refuses unknown keys, empty results and skipped rows as completion', () => {
    expect(() => contentRemaining({ unknown_table: 0 })).toThrow('ERASURE_INVALID_RESULT');
    expect(() => contentRemaining({})).toThrow('ERASURE_INVALID_RESULT');
    expect(contentRemaining({ artifact_generations_skipped: 2 })).toEqual({ remaining: 2, retry: true });
  });
});
