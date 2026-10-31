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
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kindsOf, pruneForKind, P_KIND_IS_TURN_KIND } from './db-function-kinds.mjs';

export const DEFAULTS = {
  enforceDir: 'packages/db/functions/turn',
  // Per turn kind, for one main path function at a time (Owner 2026-10-31, option A; was 15 / 10 over all kinds at once).
  maxFunctions: 15,
  maxTables: 18,
  // The ledger leaves: counted as one function each, never entered (plan 7.1). Adding a name needs the Owner's approval.
  leaves: ['atomic_pre_deduct', 'turn_settle_credits', 'credit_available', 'credit_source_apply'],
  // Row locks (FOR UPDATE / FOR SHARE ...) may only name these objects.
  lockTables: ['runtime_sessions', 'profiles', 'turns'],
  // ...and the lock's own SELECT must carry the owner key of the table (SKIP LOCKED batch claims excepted).
  lockKeys: { profiles: ['id'], runtime_sessions: ['id', 'actor_id'], turns: ['actor_id', 'id'] },
  // UPDATE may only name these tables, and the statement must carry the table's owner key.
  // The per-kind draft / report / review tables a turn may write one row of (ENGINEERING 5), with their owner keys. A kind's own PR adds
  // the table it writes, with its owner key, and cites ENGINEERING 5 (aligning with the rule, not relaxing it).
  kindTables: { artifact_rounds: ['id', 'project_id'], fusion_reviews: ['actor_id', 'id'], fusion_compares: ['actor_id', 'id'] },
  updateKeys: {
    turns: ['actor_id', 'id'], profiles: ['id'], runtime_sessions: ['id', 'actor_id'], session_messages: ['session_id'],
    turn_calls: ['turn_id'], daily_spend: ['bucket'], credit_transactions: ['user_id'], credit_source_entries: ['user_id'],
  },
};

// Listed on their own, never folded into the closure numbers above: a function that is outside the table and lock rules by an Owner
// decision (ENGINEERING 5). The line says which decision and how big the function's own closure is, so a growth shows.
export const EXCEPTIONS = { research_turn_apply: 'Owner 2026-10-30: a mentor turn may write its own research_* rows inside turn_close' };

// The one kind of database call a turn's tools may make between model calls (ENGINEERING 5, Owner 2026-10-28): a free read of the user's
// own material, by the owner's key, through the read client, with no lock, no write and no turn_calls row. Adding a name needs that rule
// to cover it; freeReadViolations holds each name to it.
export const FREE_READS = ['library_turn_read'];
// The only tables a free read may reach without an owner column (Owner 2026-11-01, ENGINEERING 5). Listed by name on purpose: any other
// table with no owner column fails. Linked tables hold rows of a row already proved the owner's, and each select must name the row by
// one of the listed keys. Catalog tables are the site-wide, admin-written, read-only ones.
export const FREE_READ_LINKED = {
  artifact_versions: ['id'], artifact_rounds: ['id'], artifact_evidence: ['id'], opc_items: ['work_item_id', 'account_project_id'],
  opc_item_edits: ['work_item_id'], opc_draft_businesses: ['draft_id', 'business_id'],
};
export const FREE_READ_CATALOG = ['modules', 'skills', 'skill_packages', 'skill_revisions', 'skill_revision_revocations'];
export const TOOLS_DIR = 'packages/api/src/services/turn/tools';

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
      list.push({ file, head: rest.slice(0, open.index), body });
      functions.set(match[1].toLowerCase(), list);
    }
  }
  return functions;
}

// Tables of an empty database: the baseline prerequisites (profiles, credit_transactions, ai_models, system_settings ...) and the migrations.
export function readTables(...dirs) {
  const tables = new Set();
  for (const file of dirs.flatMap(dir => [...sqlFiles(dir)])) {
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

// Reachable functions and tables from `root`; a leaf is counted and not entered. With `kind`, branches that kind cannot take are
// dropped (db-function-kinds.mjs); `apart` names (the EXCEPTIONS) are neither counted nor entered -- they are listed on their own.
export function closure(root, functions, tableNames, leaves = DEFAULTS.leaves, { kind = null, apart = Object.keys(EXCEPTIONS) } = {}) {
  const functionNames = new Set(functions.keys());
  const seenFunctions = new Set(), seenTables = new Set(), stack = [root];
  while (stack.length) {
    const name = stack.pop();
    if (seenFunctions.has(name) || !functions.has(name) || (apart.includes(name) && name !== root)) continue;
    seenFunctions.add(name);
    if (leaves.includes(name) && name !== root) continue;
    for (const { body } of functions.get(name)) {
      const text = kind ? pruneForKind(body, kind, P_KIND_IS_TURN_KIND.has(name)) : body;
      for (const callee of callsOf(text, functionNames)) if (callee !== name) stack.push(callee);
      for (const table of tablesOf(text, tableNames)) seenTables.add(table);
    }
  }
  return { functions: [...seenFunctions].sort(), tables: [...seenTables].sort() };
}

const statements = code => code.split(';').map(s => s.trim()).filter(Boolean);
const CTE = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([a-z_][a-z0-9_]*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi;
const cteNames = statement => new Set([...statement.matchAll(CTE)].map(m => m[1].toLowerCase()));
// The text of the select that holds position `at`: from its opening parenthesis (or the statement start) up to `at`, with nested
// parenthesised selects blanked out, so a lock is attributed to its own SELECT and not to a sibling CTE or a subquery.
function ownSelect(statement, at) {
  let depth = 0, open = -1;
  for (let i = at - 1; i >= 0; i--) {
    if (statement[i] === ')') depth++;
    else if (statement[i] === '(') { if (depth === 0) { open = i; break; } depth--; }
  }
  let out = '', nested = 0;
  for (const ch of statement.slice(open + 1, at)) {
    if (ch === '(') nested++;
    else if (ch === ')') nested = Math.max(0, nested - 1);
    else out += nested ? ' ' : ch;
  }
  // Outside parentheses the "statement" runs on through PL/pgSQL control words (a loop head and its body share one ';'-less stretch):
  // the lock's own SELECT starts after the last of them.
  return open < 0 ? out.split(/\b(?:LOOP|THEN|ELSE|BEGIN)\b/i).pop() : out;
}
// The text of the statement from `at` up to the parenthesis that closes the group `at` sits in (or the statement end), nested groups blanked.
function scopeAfter(statement, at) {
  let out = '', nested = 0;
  for (const ch of statement.slice(at)) {
    if (ch === '(') nested++;
    else if (ch === ')') { if (nested === 0) break; nested--; }
    else out += nested ? ' ' : ch;
  }
  return out;
}
const LOCK = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b(?:\s+OF\s+([a-z_][a-z0-9_.,\s]*?))?(?=\s*(?:SKIP|NOWAIT|LOOP|\)|$))/gi;
// What filters the rows: the text after the first WHERE up to the clause that follows it. A key named only in RETURNING, ORDER BY or a
// later clause does not filter anything.
const WHERE_END = new RegExp('\\b(?:RETURNING|ORDER\\s+BY|GROUP\\s+BY|HAVING|WINDOW|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|INTO'
  + '|FOR\\s+(?:NO\\s+KEY\\s+)?(?:UPDATE|SHARE|KEY\\s+SHARE))\\b', 'i');
export function whereClause(text) {
  const at = text.search(/\bWHERE\b/i);
  if (at < 0) return '';
  const rest = text.slice(at + 5);
  const end = rest.search(WHERE_END);
  return end < 0 ? rest : rest.slice(0, end);
}
const hasKey = (text, keys) => new RegExp(`\\b(?:${keys.join('|')})\\b`, 'i').test(whereClause(text));

// Violations of the plan-7.1 rules in one function body. The ledger leaves are exempt from the table lists (ENGINEERING 5: they may
// lock and write the user's own subscription and credit-package source rows) but not from the session-state rules.
export function scan(name, body, options = DEFAULTS) {
  const code = stripCode(body);
  const found = [];
  const ledger = options.leaves.includes(name);
  if (/\bpg_advisory_(?:xact_)?lock(?:_shared)?\s*\(/i.test(code)) found.push(`${name}: advisory lock`);
  if (/\bpg_try_advisory(?:_xact)?_lock/i.test(code)) found.push(`${name}: advisory lock`);
  if (/\bset_config\s*\([^)]*,\s*false\s*\)/i.test(code)) found.push(`${name}: session-level set_config`);
  if (/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i.test(code)) found.push(`${name}: temporary table`);
  // PL/pgSQL control words also end a command (IF x THEN SET ..., ELSE SET ..., BEGIN SET ...): split on them as well for the SET check only.
  for (const command of statements(code.replace(/\b(THEN|ELSE|BEGIN|LOOP)\b/gi, '$1;'))) {
    if (/^SET\s+(?!LOCAL\b)(?:SESSION\s+)?[a-z_.]+\s*(?:=|\bTO\b)/i.test(command) || /^SET\s+SESSION\b/i.test(command)) {
      found.push(`${name}: non-LOCAL SET`);
    }
  }
  for (const statement of statements(code)) {
    if (ledger) continue;
    const ctes = cteNames(statement);
    for (const lock of statement.matchAll(LOCK)) {
      const own = ownSelect(statement, lock.index);
      const from = [...own.matchAll(/\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)]
        .map(m => ({ table: m[1].toLowerCase(), alias: (m[2] ?? '').toLowerCase() })).filter(f => !ctes.has(f.table));
      const named = lock[1] ? lock[1].split(',').map(x => x.trim().split('.').pop().toLowerCase()) : null;
      const targets = named ? named.map(n => from.find(f => f.alias === n || f.table === n)?.table ?? n) : from.map(f => f.table);
      // A batch claim (SKIP LOCKED) takes whatever is due across owners by design; every other lock names its owner.
      const batch = /^\s*SKIP\s+LOCKED/i.test(statement.slice(lock.index + lock[0].length));
      for (const table of targets) {
        if (ctes.has(table)) continue;
        const keys = options.lockKeys[table];
        if (!options.lockTables.includes(table)) found.push(`${name}: row lock on ${table}`);
        else if (!batch && keys && !hasKey(own, keys)) {
          found.push(`${name}: row lock on ${table} without ${keys.join(' or ')} in WHERE`);
        }
      }
    }
    // UPDATE <table> [[AS] alias] SET, anywhere in the statement: it may follow BEGIN, THEN, ELSE or a WITH list. FOR UPDATE, ON UPDATE
    // and DO UPDATE SET are not an UPDATE of a table.
    const updateStatement = new RegExp(
      '(?<!\\bFOR\\s)(?<!\\bON\\s)(?<!\\bDO\\s)\\bUPDATE\\s+(?:ONLY\\s+)?(?:public\\.)?"?([a-z_][a-z0-9_]*)"?'
      + '(?:\\s+(?:AS\\s+)?[a-z_][a-z0-9_]*)?\\s+SET\\b', 'gi');
    // Every UPDATE in the statement (a data-modifying CTE and the outer UPDATE alike), each judged by its own WHERE.
    for (const update of statement.matchAll(updateStatement)) {
      const table = update[1].toLowerCase();
      const keys = options.updateKeys[table] ?? options.kindTables[table];
      if (!keys) found.push(`${name}: UPDATE of ${table}`);
      else if (!hasKey(scopeAfter(statement, update.index), keys)) {
        found.push(`${name}: UPDATE of ${table} without ${keys.join(' or ')} in WHERE`);
      }
    }
  }
  return found;
}

const WRITE = /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[a-z_."]+(?:\s+(?:AS\s+)?[a-z_]+)?\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE)\b/i;
const ANY_LOCK = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;
// The name counts only as a whole string literal: a concatenated or interpolated first argument is not a name this check can read.
const DB_CALL = /(?<!\b(?:Buffer|Array|Object|Set|Map))\.(rpc|from)\(\s*(?:(['"`])([a-z_0-9]*)\2\s*[,)])?/gi;
const SET_OPERATION = /\b(?:UNION|INTERSECT|EXCEPT)\b/i;
const TABLE_REF = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?"?([a-z_][a-z0-9_]*)"?)?/gi;
const NOT_ALIAS = /^(?:where|join|on|left|right|inner|outer|cross|full|group|order|limit|union|intersect|except|for|using|natural)$/i;

// The ON and WHERE text of one select: what actually limits its rows, not its output list or later clauses. Parenthesised groups are
// already blank here, so an OR left in the text is a top-level one and could let any row through: such a select proves nothing.
function rowFilters(scope) {
  const tail = scope.slice(Math.max(0, scope.search(/\bFROM\b/i)));
  // The ON of an outer join keeps the rows of its preserved side whatever it says: there only WHERE limits the rows.
  const start = tail.search(/\b(?:LEFT|RIGHT|FULL)\b/i) < 0 ? tail.search(/\b(?:ON|WHERE)\b/i) : tail.search(/\bWHERE\b/i);
  if (start < 0) return '';
  const rest = tail.slice(start), end = rest.search(WHERE_END);
  const filters = end < 0 ? rest : rest.slice(0, end);
  return /\bOR\b/i.test(filters) ? '' : filters;
}

// Whether the filters pick rows of `alias` by one of its keys, compared with something else (x.id = y.other_id, not x.id = x.id).
function namedRow(filters, alias, keys, alone) {
  if (!keys.length) return false;
  const names = keys.join('|'), side = `\\b${alias}\\.(?:${names})\\b${alone ? `|\\b(?:${names})\\b` : ''}`;
  for (const m of filters.matchAll(/([a-z_][a-z0-9_.]*)\s*=\s*([a-z_][a-z0-9_.]*)/gi)) {
    // Alone in its select, v.id and id are the same column.
    const [left, right] = [m[1], m[2]].map(name => (alone ? name.toLowerCase().replace(`${alias}.`, '') : name.toLowerCase()));
    // NOT v.id = x reads every other row.
    if (/\bNOT\s*$/i.test(filters.slice(0, m.index))) continue;
    if (left !== right && (new RegExp(`^(?:${side})$`).test(left) || new RegExp(`^(?:${side})$`).test(right))) return true;
  }
  return false;
}

// Tables of each select in `code` that are not held to the owner: directly (<alias>.actor_id = p_actor_id, profile_id for a table keyed
// by the profile) or through an equal owner column of a table in the same select that is. One filtered branch does not vouch for another.
// A listed catalog table needs no key; a listed linked table needs its row named by one of its keys, and vouches for nothing else.
export function unownedReads(code, tableNames, { linked = FREE_READ_LINKED, catalog = FREE_READ_CATALOG } = {}) {
  const found = new Set();
  for (const statement of statements(code)) {
    const ctes = cteNames(statement);
    for (const ref of statement.matchAll(TABLE_REF)) {
      const table = ref[1].toLowerCase();
      if (!tableNames.has(table) || ctes.has(table)) continue;
      // A comma join hides the next table from TABLE_REF: refused outright, a free read spells its joins.
      if (/^\s*,/.test(statement.slice(ref.index + ref[0].length))) { found.add(table); continue; }
      if (catalog.includes(table)) continue;
      const before = ownSelect(statement, ref.index).split(SET_OPERATION).pop();
      const scope = before + scopeAfter(statement, ref.index).split(SET_OPERATION)[0];
      const refs = [...scope.matchAll(TABLE_REF)].filter(m => tableNames.has(m[1].toLowerCase()))
        .map(m => ({ table: m[1].toLowerCase(), alias: (m[2] && !NOT_ALIAS.test(m[2]) ? m[2] : m[1]).toLowerCase() }));
      const filters = rowFilters(scope);
      const keyed = new Set([...filters.matchAll(/(?:\b([a-z_][a-z0-9_]*)\.)?\b(?:actor_id|profile_id)\s*=\s*p_actor_id\b/gi)]
        .flatMap(m => (m[1] ? [m[1].toLowerCase()] : refs.length === 1 ? [refs[0].alias] : [])));
      const links = [...filters.matchAll(/\b([a-z_][a-z0-9_]*)\.actor_id\s*=\s*([a-z_][a-z0-9_]*)\.actor_id\b/gi)]
        .map(m => [m[1].toLowerCase(), m[2].toLowerCase()]);
      for (let grew = true; grew;) {
        grew = false;
        for (const [a, b] of links) if (keyed.has(a) !== keyed.has(b)) { keyed.add(a); keyed.add(b); grew = true; }
      }
      const alias = (ref[2] && !NOT_ALIAS.test(ref[2]) ? ref[2] : ref[1]).toLowerCase();
      if (!keyed.has(alias) && !namedRow(filters, alias, Object.hasOwn(linked, table) ? linked[table] : [], refs.length === 1)) found.add(table);
    }
  }
  return [...found].sort();
}

// Whether the function itself rejects or filters by the owner: a comparison with p_actor_id that sits in a WHERE, an ON or an IF,
// not one that only computes a value (a select list, ORDER BY, RETURNING).
function checksOwner(code) {
  for (const statement of statements(code)) {
    for (const m of statement.matchAll(/\b(?:actor_id|profile_id)\s*=\s*p_actor_id\b/gi)) {
      const kinds = [...ownSelect(statement, m.index).matchAll(/\b(SELECT|WHERE|ON|IF|ELSIF|ORDER\s+BY|GROUP\s+BY|HAVING|RETURNING|LIMIT|FROM|JOIN)\b/gi)];
      if (/^(?:WHERE|ON|IF|ELSIF)$/i.test(kinds.at(-1)?.[1] ?? '')) return true;
    }
  }
  return false;
}

// A free read must stay what the rule allows, all the way down: read-only volatility, no write or lock in anything it reaches, and the
// owner's key as its first argument and in its filters.
export function freeReadViolations(functions, tableNames, names = FREE_READS) {
  const found = [];
  for (const name of names) {
    const defs = functions.get(name);
    if (!defs) { found.push(`${name}: free read has no function`); continue; }
    for (const { head, body } of defs) {
      if (!/\(\s*p_actor_id\s+uuid\b/i.test(head)) found.push(`${name}: free read without p_actor_id first`);
      if (!checksOwner(stripCode(body))) found.push(`${name}: free read without an owner check of its own`);
    }
    for (const reached of closure(name, functions, tableNames, []).functions) {
      for (const { head, body } of functions.get(reached) ?? []) {
        const code = stripCode(body);
        for (const table of unownedReads(code, tableNames)) found.push(`${name}: reaches a read of ${table} without the owner key in ${reached}`);
        if (!/\b(?:STABLE|IMMUTABLE)\b/i.test(head)) found.push(`${name}: reaches ${reached}, not STABLE or IMMUTABLE`);
        if (WRITE.test(code)) found.push(`${name}: reaches a write in ${reached}`);
        if (ANY_LOCK.test(code)) found.push(`${name}: reaches a row lock in ${reached}`);
      }
    }
  }
  return found;
}

// What the tool layer calls in the database. Everything else a tool needs came from turn_open or the catalog cache (ENGINEERING 5).
export function toolCallViolations(toolsDir, names = FREE_READS) {
  const found = [];
  if (!existsSync(toolsDir)) return found;
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? (entry.name === '__tests__' ? [] : walk(join(dir, entry.name)))
    : entry.name.endsWith('.ts') && !/\.(?:test|integration)\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []);
  for (const file of walk(toolsDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(DB_CALL)) {
      const line = text.slice(0, m.index).split('\n').length;
      const where = `${file.slice(toolsDir.length + 1)}:${line}`;
      if (m[1] !== 'rpc' || !names.includes(m[3])) found.push(`${where}: tool calls the database outside the free reads (.${m[1]})`);
      else if (!/\bread$/.test(text.slice(0, m.index))) found.push(`${where}: free read ${m[3]} not through the read client`);
    }
  }
  return found;
}

export function analyze({ root = process.cwd(), functionsDir = 'packages/db/functions', migrationsDir = 'packages/db/migrations',
  baselineDir = 'packages/db/baseline',
  roots = [], enforceDir = DEFAULTS.enforceDir, options = DEFAULTS } = {}) {
  const functions = readFunctions(join(root, functionsDir));
  const tables = readTables(join(root, baselineDir), join(root, migrationsDir));
  const enforceAbs = join(root, enforceDir) + sep;
  const enforced = new Map([...functions].filter(([, defs]) => defs.some(d => d.file.startsWith(enforceAbs))));
  const result = { functions: functions.size, tables: tables.size, enforcedDirPresent: existsSync(join(root, enforceDir)), roots: {}, violations: [] };
  const rootNames = roots.length ? roots : [...enforced.keys()];
  for (const name of rootNames) {
    // One closure per turn kind; a function that no kind test touches counts once under its own name, otherwise each kind is `name[kind]`.
    const perKind = kindsOf(name).map(kind => [kind, closure(name, functions, tables, options.leaves, { kind })]);
    const key = c => `${c.functions}|${c.tables}`;
    const same = perKind.every(([, c]) => key(c) === key(perKind[0][1]));
    for (const [kind, c] of same ? [[null, perKind[0][1]]] : perKind) {
      const label = kind ? `${name}[${kind}]` : name;
      result.roots[label] = { functions: c.functions.length, tables: c.tables.length, reachableFunctions: c.functions, reachableTables: c.tables };
      if (!enforced.has(name)) continue;
      for (const [what, n, max] of [['functions', c.functions.length, options.maxFunctions], ['tables', c.tables.length, options.maxTables]]) {
        if (n > max) result.violations.push(`${label}: ${n} reachable ${what} (max ${max})`);
      }
    }
  }
  for (const [name, defs] of enforced) for (const def of defs.filter(d => d.file.startsWith(enforceAbs))) result.violations.push(...scan(name, def.body,
    options));
  if (existsSync(join(root, TOOLS_DIR))) result.violations.push(...freeReadViolations(functions, tables), ...toolCallViolations(join(root, TOOLS_DIR)));
  // Report-only scan of the roots that are not enforced: what the old path would trip.
  result.reported = {};
  for (const name of rootNames.filter(n => !enforced.has(n))) {
    const c = closure(name, functions, tables, options.leaves);
    result.reported[name] = c.functions.flatMap(f => (functions.get(f) ?? []).flatMap(d => scan(f, d.body, options)));
  }
  return result;
}

// Known debt: functions already under the enforced directory when this check arrived (V2-3 merged first). A violation that is in the
// baseline is reported but does not fail; a new one, or a closure that grew, fails. The baseline only shrinks: --update-baseline
// removes what was fixed and never adds or raises anything (adding or raising needs the Owner's approval, by hand).
const CLOSURE = /^(\S+): (\d+) reachable (functions|tables) \(max \d+\)$/;
export function applyBaseline(violations, baseline = { closure: {}, rules: [] }) {
  const failing = [], known = [];
  for (const v of violations) {
    const m = CLOSURE.exec(v);
    if (m) {
      const allowed = baseline.closure?.[m[1]]?.[m[3]];
      (allowed !== undefined && Number(m[2]) <= allowed ? known : failing).push(v);
    } else (baseline.rules?.includes(v) ? known : failing).push(v);
  }
  return { failing, known };
}

export function shrinkBaseline(violations, baseline) {
  const next = { closure: {}, rules: [] };
  for (const v of violations) {
    const m = CLOSURE.exec(v);
    if (m && baseline.closure?.[m[1]]?.[m[3]] !== undefined) {
      next.closure[m[1]] ??= {};
      next.closure[m[1]][m[3]] = Math.min(Number(m[2]), baseline.closure[m[1]][m[3]]);
    } else if (!m && baseline.rules?.includes(v)) next.rules.push(v);
  }
  next.rules.sort();
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const values = flag => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const result = analyze({ roots: values('--root'), enforceDir: values('--enforce-dir')[0] ?? DEFAULTS.enforceDir });
  const baselineFile = join(import.meta.dirname, 'db-function-closure-baseline.json');
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : { closure: {}, rules: [] };
  const { failing, known } = applyBaseline(result.violations, baseline);
  if (args.includes('--update-baseline')) {
    writeFileSync(baselineFile, JSON.stringify(shrinkBaseline(result.violations, baseline), null, 1) + '\n');
  }
  if (args.includes('--json')) console.log(JSON.stringify({ ...result, failing, known }, null, 1));
  else {
    console.log(`functions ${result.functions}, tables ${result.tables}; enforced directory present: ${result.enforcedDirPresent}`);
    for (const [name, r] of Object.entries(result.roots)) console.log(`  ${name}: ${r.functions} functions, ${r.tables} tables`);
    if (args.includes('--report')) {
      for (const [name, list] of Object.entries(result.reported)) console.log(`  [report] ${name}: ${new Set(list).size} rule hits`);
    }
    for (const [name, why] of Object.entries(EXCEPTIONS)) {
      const c = closure(name, readFunctions(join(process.cwd(), 'packages/db/functions')), readTables(join(process.cwd(), 'packages/db/baseline'),
        join(process.cwd(), 'packages/db/migrations')));
      console.log(`EXCEPTION ${name}: ${c.functions.length} functions, ${c.tables.length} tables (${why})`);
    }
    for (const v of known) console.log(`KNOWN (baseline) ${v}`);
    for (const v of failing) console.error(`VIOLATION ${v}`);
  }
  if (failing.length) process.exit(1);
}
