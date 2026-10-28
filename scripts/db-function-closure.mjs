/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Static guard for the main path's database functions (CORE-PATH-V2 plan 3.1, 3.3.2, 7.1).
//   1. Closure: how many functions and tables a root function can reach through packages/db/functions (ledger leaves are
//      counted once and not entered).
//   2. Scan: row-lock objects, UPDATE targets and their owner keys, session-level state (pg_advisory_lock, non-LOCAL SET,
//      temporary tables) -- the three things that stop a function from scaling past one hot row or from running behind a
//      transaction-mode connection pool.
// Functions under the enforced directory (default packages/db/functions/turn, absent until V2-3) must pass; every other
// function is only reported, so the old path never turns the check red.
// Usage: node scripts/db-function-closure.mjs [--root name]... [--enforce-dir dir] [--report] [--json]
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  enforceDir: 'packages/db/functions/turn',
  maxFunctions: 15,
  maxTables: 10,
  // The ledger leaves: counted as one function each, never entered (plan 7.1). Adding a name needs the Owner's approval.
  leaves: ['atomic_pre_deduct', 'turn_settle_credits', 'credit_available', 'credit_source_apply'],
  // Row locks (FOR UPDATE / FOR SHARE ...) may only name these objects.
  lockTables: ['runtime_sessions', 'profiles', 'turns'],
  // UPDATE may only name these tables, and the statement must carry the table's owner key.
  updateKeys: {
    turns: ['actor_id', 'id'], profiles: ['id'], runtime_sessions: ['id', 'actor_id'], session_messages: ['session_id'],
    turn_calls: ['turn_id'], daily_spend: ['bucket'], credit_transactions: ['user_id'], credit_source_entries: ['user_id'],
  },
};

const KEYWORDS = new Set(['if', 'in', 'values', 'select', 'from', 'exists', 'case', 'when', 'and', 'or', 'not', 'on', 'as', 'using',
  'returning', 'coalesce', 'nullif', 'greatest', 'least', 'count', 'sum', 'max', 'min', 'array_agg', 'jsonb_build_object',
  'jsonb_build_array', 'jsonb_array_elements', 'to_jsonb', 'now', 'clock_timestamp', 'lateral', 'any', 'all', 'set', 'where']);

// Remove -- comments and 'string literals' so words inside messages or comments are not read as code.
export function stripCode(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
}

export function* sqlFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sqlFiles(path);
    else if (name.endsWith('.sql')) yield path;
  }
}

// name -> [{ file, body }] for every CREATE [OR REPLACE] FUNCTION in the snapshot files.
export function readFunctions(functionsDir) {
  const functions = new Map();
  for (const file of sqlFiles(functionsDir)) {
    const text = readFileSync(file, 'utf8');
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    for (const match of text.matchAll(re)) {
      const rest = text.slice(match.index);
      const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(rest);
      if (!open) continue;
      const bodyStart = open.index + open[0].length;
      const end = rest.indexOf(open[1], bodyStart);
      const body = rest.slice(bodyStart, end < 0 ? undefined : end);
      const list = functions.get(match[1].toLowerCase()) ?? [];
      list.push({ file, body });
      functions.set(match[1].toLowerCase(), list);
    }
  }
  return functions;
}

export function readTables(migrationsDir) {
  const tables = new Set();
  for (const file of sqlFiles(migrationsDir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi))
      tables.add(m[1].toLowerCase());
  }
  return tables;
}

export function callsOf(body, functionNames) {
  const out = new Set();
  for (const m of stripCode(body).matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const name = m[1].toLowerCase();
    if (!KEYWORDS.has(name) && functionNames.has(name)) out.add(name);
  }
  return out;
}

export function tablesOf(body, tableNames) {
  const out = new Set();
  const code = stripCode(body);
  for (const m of code.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    const name = m[1].toLowerCase();
    if (tableNames.has(name)) out.add(name);
  }
  return out;
}

// Reachable functions and tables from `root`; a leaf is counted and not entered.
export function closure(root, functions, tableNames, leaves = DEFAULTS.leaves) {
  const functionNames = new Set(functions.keys());
  const seenFunctions = new Set(), seenTables = new Set(), stack = [root];
  while (stack.length) {
    const name = stack.pop();
    if (seenFunctions.has(name) || !functions.has(name)) continue;
    seenFunctions.add(name);
    if (leaves.includes(name) && name !== root) continue;
    for (const { body } of functions.get(name)) {
      for (const callee of callsOf(body, functionNames)) if (callee !== name) stack.push(callee);
      for (const table of tablesOf(body, tableNames)) seenTables.add(table);
    }
  }
  return { functions: [...seenFunctions].sort(), tables: [...seenTables].sort() };
}

const statements = code => code.split(';').map(s => s.trim()).filter(Boolean);

// Violations of the plan-7.1 rules in one function body.
export function scan(name, body, options = DEFAULTS) {
  const code = stripCode(body);
  const found = [];
  if (/\bpg_advisory_(?:xact_)?lock(?:_shared)?\s*\(/i.test(code)) found.push(`${name}: advisory lock`);
  if (/\bpg_try_advisory(?:_xact)?_lock/i.test(code)) found.push(`${name}: advisory lock`);
  if (/^\s*SET\s+(?!LOCAL\b)(?:SESSION\s+)?[a-z_.]+\s*(?:=|\bTO\b)/im.test(code) || /\bSET\s+SESSION\b/i.test(code)) found.push(`${name}: non-LOCAL SET`);
  if (/\bset_config\s*\([^)]*,\s*false\s*\)/i.test(code)) found.push(`${name}: session-level set_config`);
  if (/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i.test(code)) found.push(`${name}: temporary table`);
  for (const statement of statements(code)) {
    const lock = /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b(?:\s+OF\s+([a-z_][a-z0-9_.,\s]*?))?(?=\s*(?:SKIP|NOWAIT|$)|\s*$)/i.exec(statement)
      ?? /\bFOR\s+(?:KEY\s+)?SHARE\b/i.exec(statement);
    if (lock) {
      const named = lock[1] ? lock[1].split(',').map(s => s.trim().split('.').pop().toLowerCase()) : null;
      const from = [...statement.matchAll(/\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)]
        .map(m => ({ table: m[1].toLowerCase(), alias: (m[2] ?? '').toLowerCase() }));
      const targets = named ? named.map(n => from.find(f => f.alias === n || f.table === n)?.table ?? n) : from.map(f => f.table);
      for (const table of targets.length ? targets : ['?']) if (!options.lockTables.includes(table)) found.push(`${name}: row lock on ${table}`);
    }
    const update = /^\s*(?:WITH\b[\s\S]*?\)\s*)?UPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(statement)
      ?? /\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+(?:AS\s+[a-z_]+\s+)?SET\b/i.exec(statement);
    if (update) {
      const table = update[1].toLowerCase();
      const keys = options.updateKeys[table];
      if (!keys) found.push(`${name}: UPDATE of ${table}`);
      else if (!new RegExp(`\\bWHERE\\b[\\s\\S]*\\b(?:${keys.join('|')})\\b`,
        'i').test(statement)) found.push(`${name}: UPDATE of ${table} without ${keys.join(' or ')} in WHERE`);
    }
  }
  return found;
}

export function analyze({ root = process.cwd(), functionsDir = 'packages/db/functions', migrationsDir = 'packages/db/migrations',
  roots = [], enforceDir = DEFAULTS.enforceDir, options = DEFAULTS } = {}) {
  const functions = readFunctions(join(root, functionsDir));
  const tables = readTables(join(root, migrationsDir));
  const enforceAbs = join(root, enforceDir) + sep;
  const enforced = new Map([...functions].filter(([, defs]) => defs.some(d => d.file.startsWith(enforceAbs))));
  const result = { functions: functions.size, tables: tables.size, enforcedDirPresent: existsSync(join(root, enforceDir)), roots: {}, violations: [] };
  const rootNames = roots.length ? roots : [...enforced.keys()];
  for (const name of rootNames) {
    const c = closure(name, functions, tables, options.leaves);
    result.roots[name] = { functions: c.functions.length, tables: c.tables.length, reachableFunctions: c.functions, reachableTables: c.tables };
    if (enforced.has(name)) {
      if (c.functions.length > options.maxFunctions) result.violations.push(`${name}: ${c.functions.length} reachable functions (max ${options.maxFunctions})`);
      if (c.tables.length > options.maxTables) result.violations.push(`${name}: ${c.tables.length} reachable tables (max ${options.maxTables})`);
    }
  }
  for (const [name, defs] of enforced) for (const def of defs.filter(d => d.file.startsWith(enforceAbs))) result.violations.push(...scan(name, def.body,
    options));
  // Report-only scan of the roots that are not enforced: what the old path would trip.
  result.reported = {};
  for (const name of rootNames.filter(n => !enforced.has(n))) {
    const c = closure(name, functions, tables, options.leaves);
    result.reported[name] = c.functions.flatMap(f => (functions.get(f) ?? []).flatMap(d => scan(f, d.body, options)));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const values = flag => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const result = analyze({ roots: values('--root'), enforceDir: values('--enforce-dir')[0] ?? DEFAULTS.enforceDir });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`functions ${result.functions}, tables ${result.tables}; enforced directory present: ${result.enforcedDirPresent}`);
    for (const [name, r] of Object.entries(result.roots)) console.log(`  ${name}: ${r.functions} functions, ${r.tables} tables`);
    for (const [name,
      list] of Object.entries(result.reported)) if (args.includes('--report')) console.log(`  [report] ${name}: ${new Set(list).size} rule hits`);
    for (const v of result.violations) console.error(`VIOLATION ${v}`);
  }
  if (result.violations.length) process.exit(1);
}
