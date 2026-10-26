#!/usr/bin/env node

// New migrations change an existing database function by writing its whole definition with CREATE OR REPLACE
// (docs/ENGINEERING.md, "改已有数据库函数的写法"), never by reading the function's text and patching it
// (pg_get_functiondef / prosrc with replace, regexp_replace, overlay, position and the like). Migrations before
// FIRST_CHECKED keep their patches; rewriting them would change history that staging already ran.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = 'packages/db/migrations';
export const FIRST_CHECKED = 398;

const FUNCTION_HEADER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/gi;
const BODY_START = /\bAS\s+(\$[A-Za-z_0-9]*\$)/gi;
const TEXT_SOURCE = /\b(?:pg_get_functiondef|prosrc)\b/i;
const TEXT_EDIT = /\b(?:replace|regexp_replace|overlay|position|strpos|split_part|substring|substr)\s*\(/i;

/**
 * The migration without the bodies of the functions it defines: a whole definition may use replace() on its own data.
 * A body that itself reads function text stays (a pg_temp patch helper is a patch too). What is left (DO blocks, DDL,
 * helpers) is where a patch of another function's text would live.
 */
export function withoutFunctionBodies(sql) {
  let rest = sql;
  let out = '';
  for (;;) {
    FUNCTION_HEADER.lastIndex = 0;
    const header = FUNCTION_HEADER.exec(rest);
    if (!header) return out + rest;
    BODY_START.lastIndex = header.index;
    const start = BODY_START.exec(rest);
    if (!start) return out + rest;
    const tag = start[1];
    const end = rest.indexOf(tag, start.index + start[0].length);
    if (end < 0) return out + rest;
    const body = rest.slice(start.index, end + tag.length);
    out += rest.slice(0, start.index) + (TEXT_SOURCE.test(body) ? body : '');
    rest = rest.slice(end + tag.length);
  }
}

const withoutLineComments = sql => sql.replace(/--[^\n]*/g, '');

/** True when the migration reads a function's text and edits it as text. */
export function patchesFunctionText(sql) {
  const outside = withoutLineComments(withoutFunctionBodies(sql));
  return TEXT_SOURCE.test(outside) && TEXT_EDIT.test(outside);
}

export const migrationNumber = file => {
  const match = /^(\d{4})_.*\.sql$/.exec(file);
  return match ? Number(match[1]) : null;
};

/** `migrations`: Map of file name → text. Returns the checked files that patch function text. */
export function findPatches(migrations) {
  return [...migrations].filter(([file, text]) => (migrationNumber(file) ?? -1) >= FIRST_CHECKED && patchesFunctionText(text))
    .map(([file]) => file).sort();
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(repositoryRoot, MIGRATIONS_DIR);
  const migrations = new Map();
  for (const file of (await readdir(dir)).filter(name => (migrationNumber(name) ?? -1) >= FIRST_CHECKED)) {
    migrations.set(file, await readFile(path.join(dir, file), 'utf8'));
  }
  const found = findPatches(migrations);
  if (found.length > 0) {
    console.error(`Function text patches in new migrations:\n${found.map(file => `  ${MIGRATIONS_DIR}/${file}`).join('\n')}`);
    console.error('Copy the current definition from packages/db/functions/, edit it whole and write it with CREATE OR REPLACE.');
    console.error('See docs/ENGINEERING.md, "改已有数据库函数的写法".');
    process.exitCode = 1;
    return;
  }
  console.log(`Function patch check passed for ${migrations.size} migration(s) from ${String(FIRST_CHECKED).padStart(4, '0')}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
