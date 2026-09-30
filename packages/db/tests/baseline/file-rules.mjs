/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-BASELINE rules for files outside the migration ledger (the core baseline and bridges).
// Shared by scripts/tests/db-baseline-bridges.test.mjs and run-db-baseline-replay.mjs, which also
// executes these files with `psql -c` so the server, not psql, parses them (no \! / \i / \gexec).

const withoutComments = sql => sql.replace(/--.*$/gm, '');
export const statementsOf = sql => withoutComments(sql).split(';').map(part => part.trim()).filter(Boolean);

// Any line starting with a backslash (after leading blanks) is a psql meta-command.
export function metaCommandLines(sql) {
  return withoutComments(sql).split('\n').filter(line => /^\s*\\/.test(line)).map(line => line.trim());
}

// Bridges may only drop objects that may already be absent.
export function bridgeViolations(sql) {
  const problems = metaCommandLines(sql).map(line => `psql meta-command: ${line}`);
  if (/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(sql)) problems.push('dollar-quoted block');
  const statements = statementsOf(sql);
  if (statements.length === 0) problems.push('no statements');
  for (const statement of statements) {
    if (!/^DROP\s+(POLICY|TRIGGER|INDEX|VIEW|FUNCTION)\s+IF\s+EXISTS\s+[^;\\]+$/i.test(statement)) {
      problems.push(`not a DROP ... IF EXISTS: ${statement.replace(/\s+/g, ' ')}`);
    }
  }
  return problems;
}

// The core baseline only sets default privileges and creates plain tables (no rows, roles or
// schemas, no CREATE TABLE ... AS, no client grants except staging's sequence UPDATE default).
export const ALLOWED_CLIENT_DEFAULT =
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role';
export function baselineViolations(sql) {
  const problems = metaCommandLines(sql).map(line => `psql meta-command: ${line}`);
  if (/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(sql)) problems.push('dollar-quoted block');
  for (const statement of statementsOf(sql)) {
    const flat = statement.replace(/\s+/g, ' ');
    const kind = flat.split(' ').slice(0, 2).join(' ').toUpperCase();
    if (!['ALTER DEFAULT', 'BEGIN', 'COMMIT', 'CREATE TABLE'].includes(kind)) problems.push(`statement kind: ${kind}`);
    if (kind === 'CREATE TABLE' && (/\)\s*AS\b|\bAS\s*\(?\s*(SELECT|VALUES|TABLE|WITH)\b/i.test(flat)
      || !/^CREATE TABLE public\.[a-z_]+ \(/i.test(flat))) {
      problems.push(`CREATE TABLE must be a plain column list: ${flat.slice(0, 80)}`);
    }
    if (/\bGRANT\b[\s\S]*\bTO\s+[^;]*\b(PUBLIC|anon|authenticated)\b/i.test(flat) && flat !== ALLOWED_CLIENT_DEFAULT) {
      problems.push(`client grant: ${flat}`);
    }
  }
  return problems;
}
