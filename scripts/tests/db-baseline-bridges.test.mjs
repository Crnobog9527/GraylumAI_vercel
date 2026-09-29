/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-BASELINE guard rails for files that only run when building an empty database from files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const baselineDir = resolve(root, 'packages/db/baseline');
const bridgeDir = resolve(baselineDir, 'bridges');
const migrations = new Set(readdirSync(resolve(root, 'packages/db/migrations')));
const statementsOf = sql => sql.replace(/--.*$/gm, '').split(';').map(part => part.trim()).filter(Boolean);

test('every bridge is named after an existing migration and runs right before it', () => {
  const bridges = readdirSync(bridgeDir);
  assert.ok(bridges.length > 0);
  for (const bridge of bridges) {
    assert.match(bridge, /^\d{4}_[A-Za-z0-9._-]+\.sql$/, bridge);
    assert.ok(migrations.has(bridge), `${bridge} must share its name with a migration`);
  }
});

test('bridges only drop objects that may already be absent', () => {
  for (const bridge of readdirSync(bridgeDir)) {
    const sql = readFileSync(resolve(bridgeDir, bridge), 'utf8');
    assert.doesNotMatch(sql, /\$\$|\$[A-Za-z_]+\$/, `${bridge}: no dollar-quoted blocks`);
    const statements = statementsOf(sql);
    assert.ok(statements.length > 0, bridge);
    for (const statement of statements) {
      assert.match(statement, /^DROP\s+(POLICY|TRIGGER|INDEX|VIEW|FUNCTION)\s+IF\s+EXISTS\s+[^;]+$/i,
        `${bridge}: only DROP ... IF EXISTS is allowed, got: ${statement}`);
    }
  }
});

test('the core baseline creates structure only: no rows, roles or client grants', () => {
  const files = readdirSync(baselineDir).filter(file => file.endsWith('.sql'));
  assert.deepEqual(files, ['0000_core_prerequisites.sql']);
  const sql = readFileSync(resolve(baselineDir, files[0]), 'utf8').replace(/--.*$/gm, '');
  const kinds = statementsOf(sql).map(statement => statement.split(/\s+/).slice(0, 2).join(' ').toUpperCase());
  assert.deepEqual([...new Set(kinds)].sort(), ['ALTER DEFAULT', 'BEGIN', 'COMMIT', 'CREATE TABLE']);
  // Client roles get nothing by default except staging's sequence UPDATE default (no public
  // sequence exists; kept for parity with staging's pg_default_acl).
  const clientGrants = statementsOf(sql)
    .filter(statement => /\bGRANT\b[\s\S]*\bTO\s+[^;]*\b(PUBLIC|anon|authenticated)\b/i.test(statement));
  assert.deepEqual(clientGrants.map(statement => statement.replace(/\s+/g, ' ')), [
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role',
  ]);
});
