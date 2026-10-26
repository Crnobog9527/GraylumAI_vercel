import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FIRST_CHECKED, findPatches, withoutLineComments, migrationNumber, patchesFunctionText, withoutFunctionBodies } from '../check-function-patches.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const old = name => readFile(path.join(repositoryRoot, 'packages/db/migrations', name), 'utf8');

const WHOLE = `CREATE OR REPLACE FUNCTION public.clean_name(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $f$
BEGIN
  -- a whole definition may edit its own data as text
  RETURN regexp_replace(replace(p, '  ', ' '), '^\\s+', '');
END $f$;`;

const GUARDED = `DO $$
BEGIN
  IF md5(pg_get_functiondef('public.clean_name(text)'::regprocedure)) NOT IN ('a', 'b') THEN
    RAISE EXCEPTION 'BASE_MISMATCH';
  END IF;
END $$;
${WHOLE}`;

const PATCH = `DO $$
DECLARE source text := pg_get_functiondef('public.clean_name(text)'::regprocedure);
BEGIN
  IF position('-- done' IN source) = 0 THEN
    EXECUTE replace(source, 'RETURN', '-- done' || chr(10) || 'RETURN');
  END IF;
END $$;`;

test('flags reading a function and editing its text, in any of the usual forms', () => {
  assert.equal(patchesFunctionText(PATCH), true);
  assert.equal(patchesFunctionText(`DO $$ DECLARE s text; BEGIN SELECT prosrc INTO s FROM pg_proc WHERE proname='f';
    EXECUTE regexp_replace(s, 'a', 'b'); END $$;`), true);
  assert.equal(patchesFunctionText(`DO $$ DECLARE s text := pg_get_functiondef('f()'::regprocedure);
    BEGIN EXECUTE overlay(s placing 'x' from 3 for 1); END $$;`), true);
});

test('lets a whole CREATE OR REPLACE, an md5 base guard and an ordinary DO block through', () => {
  assert.equal(patchesFunctionText(WHOLE), false);
  assert.equal(patchesFunctionText(GUARDED), false);
  assert.equal(patchesFunctionText(`DO $$ BEGIN UPDATE settings SET value = replace(value, 'a', 'b'); END $$;`), false);
  assert.equal(patchesFunctionText(`-- never patch with pg_get_functiondef and replace()\n${WHOLE}`), false);
});

test('still flags a patch placed after a whole function in the same file', () => {
  assert.equal(patchesFunctionText(`${WHOLE}\n${PATCH}`), true);
  assert.match(withoutFunctionBodies(`${WHOLE}\nSELECT 1;`), /SELECT 1;/);
  assert.doesNotMatch(withoutFunctionBodies(WHOLE), /regexp_replace/);
});

test('checks migrations from FIRST_CHECKED on and leaves older ones alone', () => {
  assert.equal(FIRST_CHECKED, 398);
  assert.equal(migrationNumber('0398_x.sql'), 398);
  assert.equal(migrationNumber('README.md'), null);
  const files = new Map([['0397_old.sql', PATCH], ['0398_new.sql', PATCH], ['0399_whole.sql', GUARDED]]);
  assert.deepEqual(findPatches(files), ['0398_new.sql']);
});

test('a -- inside a string literal does not hide the patch after it', () => {
  assert.equal(patchesFunctionText(`DO $$ DECLARE source text := pg_get_functiondef('public.f()'::regprocedure);
BEGIN IF source NOT LIKE '%-- patched%' THEN EXECUTE replace(source, 'RETURN 1', 'RETURN 2'); END IF; END $$;`), true);
  assert.equal(patchesFunctionText(`DO $$ DECLARE source text := pg_get_functiondef('public.f()'::regprocedure);
BEGIN IF source NOT LIKE $m$%-- patched%$m$ THEN EXECUTE replace(source, 'a', 'b'); END IF; END $$;`), true);
  assert.equal(patchesFunctionText(`DO $$ DECLARE source text := pg_get_functiondef('f()'::regprocedure);
BEGIN IF position('it''s -- x' IN source) = 0 THEN EXECUTE replace(source, 'a', 'b'); END IF; END $$;`), true);
  assert.equal(withoutLineComments("SELECT 1; -- replace(x)\nSELECT '--';"), "SELECT 1; \nSELECT '--';");
});

test('flags a patch helper written as a function', () => {
  assert.equal(patchesFunctionText(`CREATE FUNCTION pg_temp.patch(fn regprocedure, a text, b text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE src text := pg_get_functiondef(fn); BEGIN EXECUTE replace(src, a, b); END $$;
SELECT pg_temp.patch('public.f()', 'x', 'y');`), true);
});

test('recognizes the real patches of 0344, 0383, 0393 and 0395, and lets the guarded whole rewrite of 0391 through', async () => {
  for (const name of ['0344_content_erasure_scope_speed.sql', '0383_credit_grant_quarantine.sql',
    '0393_erasure_research_context_retained.sql', '0395_erasure_prune_error_codes.sql']) {
    assert.equal(patchesFunctionText(await old(name)), true, name);
  }
  assert.equal(patchesFunctionText(await old('0391_credit_available.sql')), false);
});

test('the repository passes the check', () => {
  const result = spawnSync(process.execPath, ['scripts/check-function-patches.mjs'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
