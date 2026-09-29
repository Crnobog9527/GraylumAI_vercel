/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-BASELINE guard rails for files that only run when building an empty database from files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { baselineViolations, bridgeViolations } from '../../packages/db/tests/baseline/file-rules.mjs';

const root = resolve(import.meta.dirname, '../..');
const baselineDir = resolve(root, 'packages/db/baseline');
const bridgeDir = resolve(baselineDir, 'bridges');
const migrations = new Set(readdirSync(resolve(root, 'packages/db/migrations')));

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
    assert.deepEqual(bridgeViolations(readFileSync(resolve(bridgeDir, bridge), 'utf8')), [], bridge);
  }
});

test('the core baseline creates structure only: no rows, roles or client grants', () => {
  const files = readdirSync(baselineDir).filter(file => file.endsWith('.sql'));
  assert.deepEqual(files, ['0000_core_prerequisites.sql']);
  assert.deepEqual(baselineViolations(readFileSync(resolve(baselineDir, files[0]), 'utf8')), []);
});

test('bridge rules reject psql meta-commands, smuggled SQL and dollar-quoted blocks', () => {
  const drop = 'DROP POLICY IF EXISTS x ON public.t';
  for (const smuggled of [
    `${drop}\n\\! echo shell\n;`,
    `${drop}\n  \\i /tmp/other.sql\n;`,
    `SELECT 'DROP POLICY IF EXISTS y ON public.t' \\gexec\n;`,
    `${drop};\n\t\\gexec`,
    `${drop};\nGRANT ALL ON public.t TO anon;`,
    `${drop};\nCREATE TABLE public.x (id int);`,
    `DO $$ BEGIN EXECUTE 'GRANT ALL ON public.t TO anon'; END $$;`,
    '',
  ]) {
    assert.notDeepEqual(bridgeViolations(smuggled), [], JSON.stringify(smuggled));
  }
  assert.deepEqual(bridgeViolations(`-- note\n${drop};\nDROP TRIGGER IF EXISTS g ON public.t;\n`), []);
});

test('baseline rules reject meta-commands, CREATE TABLE AS, data and client grants', () => {
  const table = 'CREATE TABLE public.a (id uuid NOT NULL)';
  for (const smuggled of [
    `BEGIN;\n${table}\n\\! echo shell\n;\nCOMMIT;`,
    'BEGIN;\nCREATE TABLE public.b AS SELECT * FROM pg_authid;\nCOMMIT;',
    'BEGIN;\nCREATE TABLE public.b (id) AS (SELECT 1);\nCOMMIT;',
    'BEGIN;\nCREATE TABLE public.b AS\n  WITH x AS (SELECT 1) SELECT * FROM x;\nCOMMIT;',
    'BEGIN;\nINSERT INTO public.a VALUES (gen_random_uuid());\nCOMMIT;',
    'BEGIN;\nCREATE ROLE smuggled;\nCOMMIT;',
    `BEGIN;\n${table};\nGRANT SELECT ON public.a TO anon;\nCOMMIT;`,
    'BEGIN;\nALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;\nCOMMIT;',
    'BEGIN;\nCREATE TABLE other.a (id int);\nCOMMIT;',
  ]) {
    assert.notDeepEqual(baselineViolations(smuggled), [], JSON.stringify(smuggled));
  }
  assert.deepEqual(baselineViolations(`BEGIN;\n${table};\nCOMMIT;`), []);
});
