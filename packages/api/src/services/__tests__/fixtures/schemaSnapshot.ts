/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';

/**
 * Integration cases that replay an old migration on the shared disposable
 * database (to prove an upgrade or compatibility path) must not leave the old
 * definitions behind for every later case. A separate cloned database would
 * not help: those cases observe the replay through the local PostgREST and
 * website, which only reach the shared database.
 *
 * snapshotSchema() records every public schema object a migration can change:
 * function definitions with their attributes (SECURITY DEFINER, search_path),
 * owner and ACL; views with ACL; table ACL and RLS flags; policies; triggers;
 * constraints; and columns. The returned restore() puts everything back and
 * then compares a fresh snapshot object by object. Any object it cannot
 * restore exactly fails the case and is named, so a polluting replay surfaces
 * where it happens instead of breaking unrelated later cases.
 */
type Query = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
type Entry = Record<string, unknown>;
type Snapshot = Map<string, Entry>;

const SNAPSHOT_SQL: Array<[string, string]> = [
  ['function', `select 'function:'||p.oid::regprocedure::text key, p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def,
    pg_get_userbyid(p.proowner) owner, p.proacl::text acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind in ('f','p')
      and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')`],
  ['view', `select 'view:'||c.oid::regclass::text key, c.oid::regclass::text name, pg_get_viewdef(c.oid) def,
    pg_get_userbyid(c.relowner) owner, c.relacl::text acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'`],
  ['table', `select 'table:'||c.oid::regclass::text key, c.oid::regclass::text name, c.relacl::text acl,
    c.relrowsecurity rls, c.relforcerowsecurity force_rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')`],
  ['column', `select 'column:'||c.oid::regclass::text||'.'||a.attname key, format_type(a.atttypid,a.atttypmod) type,
    a.attnotnull notnull, pg_get_expr(d.adbin,d.adrelid) dflt
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`],
  ['policy', `select 'policy:'||c.oid::regclass::text||'.'||p.polname key, c.oid::regclass::text tbl, p.polname name,
    p.polcmd cmd, p.polpermissive permissive,
    (select coalesce(string_agg(case r when 0 then 'public' else quote_ident(pg_get_userbyid(r)) end, ',' order by r),'public')
      from unnest(p.polroles) r) roles,
    pg_get_expr(p.polqual,p.polrelid) qual, pg_get_expr(p.polwithcheck,p.polrelid) chk
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`],
  ['trigger', `select 'trigger:'||c.oid::regclass::text||'.'||t.tgname key, c.oid::regclass::text tbl, t.tgname name,
    pg_get_triggerdef(t.oid) def, t.tgenabled enabled
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal`],
  ['constraint', `select 'constraint:'||c.oid::regclass::text||'.'||k.conname key, c.oid::regclass::text tbl, k.conname name,
    pg_get_constraintdef(k.oid) def
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and k.contype in ('c','f','u','p','x')`],
];

async function capture(sql: Query): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  for (const [kind, text] of SNAPSHOT_SQL)
    for (const row of (await sql.query(text)).rows) snapshot.set(String(row.key), { ...row, kind });
  return snapshot;
}

const ident = (value: unknown) => '"' + String(value).replaceAll('"', '""') + '"';
const digest = (entry: Entry | undefined) =>
  entry ? createHash('md5').update(JSON.stringify(entry)).digest('hex') : 'missing';

/** GRANT statements for an aclitem[] text; NULL means the object's default privileges. */
async function restoreAcl(sql: Query, target: string, before: string | null, after: string | null, defaultGrant: string | null) {
  if (before === after) return;
  const grantees = (await sql.query(
    "select distinct case grantee when 0 then 'public' else quote_ident(pg_get_userbyid(grantee)) end g from aclexplode($1::aclitem[])",
    [after ?? '{}'],
  )).rows.map(row => String(row.g));
  for (const grantee of new Set([...grantees, 'public'])) await sql.query(`revoke all on ${target} from ${grantee}`);
  if (before === null) {
    if (defaultGrant) await sql.query(`grant ${defaultGrant} on ${target} to public`);
    return;
  }
  for (const row of (await sql.query(
    `select privilege_type p, case grantee when 0 then 'public' else quote_ident(pg_get_userbyid(grantee)) end g,
      is_grantable o from aclexplode($1::aclitem[]) where grantee<>grantor`,
    [before],
  )).rows) await sql.query(`grant ${row.p} on ${target} to ${row.g}${row.o ? ' with grant option' : ''}`);
}

async function restore(sql: Query, before: Snapshot) {
  const after = await capture(sql);
  const changed = (key: string) => digest(before.get(key)) !== digest(after.get(key));
  const ordered = (kind: string) => [...new Set([...before.keys(), ...after.keys()])]
    .filter(key => (before.get(key) ?? after.get(key))!.kind === kind && changed(key));
  // Remove objects the replay added or changed before restoring definitions.
  for (const key of ordered('trigger')) { const e = (after.get(key) ?? before.get(key))!;
    await sql.query(`drop trigger if exists ${ident(e.name)} on ${e.tbl}`); }
  for (const key of ordered('policy')) { const e = (after.get(key) ?? before.get(key))!;
    await sql.query(`drop policy if exists ${ident(e.name)} on ${e.tbl}`); }
  for (const key of ordered('constraint')) { const e = (after.get(key) ?? before.get(key))!;
    if (after.has(key)) await sql.query(`alter table ${e.tbl} drop constraint if exists ${ident(e.name)}`); }
  for (const key of ordered('view')) if (!before.has(key)) await sql.query(`drop view if exists ${after.get(key)!.name}`);
  for (const key of ordered('function')) if (!before.has(key)) await sql.query(`drop function if exists ${after.get(key)!.sig}`);
  for (const key of ordered('function')) {
    const e = before.get(key); if (!e) continue;
    const current = after.get(key);
    if (!current || current.def !== e.def) {
      try { await sql.query(String(e.def)); }
      catch { await sql.query(`drop function if exists ${e.sig}`); await sql.query(String(e.def)); }
    }
    if (current?.owner !== e.owner) await sql.query(`alter function ${e.sig} owner to ${ident(e.owner)}`);
    await restoreAcl(sql, `function ${e.sig}`, e.acl as string | null, current ? current.acl as string | null : null, 'execute');
  }
  for (const key of ordered('view')) {
    const e = before.get(key); if (!e) continue;
    const current = after.get(key);
    if (!current || current.def !== e.def) await sql.query(`create or replace view ${e.name} as ${e.def}`);
    if (current?.owner !== e.owner) await sql.query(`alter view ${e.name} owner to ${ident(e.owner)}`);
    await restoreAcl(sql, `table ${e.name}`, e.acl as string | null, current ? current.acl as string | null : null, null);
  }
  for (const key of ordered('table')) {
    const e = before.get(key), current = after.get(key); if (!e || !current) continue;
    await restoreAcl(sql, `table ${e.name}`, e.acl as string | null, current.acl as string | null, null);
    await sql.query(`alter table ${e.name} ${e.rls ? 'enable' : 'disable'} row level security`);
    await sql.query(`alter table ${e.name} ${e.force_rls ? 'force' : 'no force'} row level security`);
  }
  for (const key of ordered('constraint')) { const e = before.get(key);
    if (e) await sql.query(`alter table ${e.tbl} add constraint ${ident(e.name)} ${e.def}`); }
  for (const key of ordered('policy')) { const e = before.get(key); if (!e) continue;
    const command = { r: 'select', a: 'insert', w: 'update', d: 'delete', '*': 'all' }[String(e.cmd)];
    await sql.query(`create policy ${ident(e.name)} on ${e.tbl} as ${e.permissive ? 'permissive' : 'restrictive'} for ${command}
      to ${e.roles}${e.qual ? ` using (${e.qual})` : ''}${e.chk ? ` with check (${e.chk})` : ''}`); }
  for (const key of ordered('trigger')) { const e = before.get(key); if (!e) continue;
    await sql.query(String(e.def));
    const mode = { O: 'enable', D: 'disable', R: 'enable replica', A: 'enable always' }[String(e.enabled)];
    if (e.enabled !== 'O') await sql.query(`alter table ${e.tbl} ${mode} trigger ${ident(e.name)}`); }
  // Verify object by object; columns are never altered back, only reported.
  const final = await capture(sql);
  const different = [...new Set([...before.keys(), ...final.keys()])].filter(key => digest(before.get(key)) !== digest(final.get(key)));
  if (different.length) throw new Error('SCHEMA_NOT_RESTORED: ' + different.slice(0, 20).join(', '));
}

/** One server-side digest over the same rows, cheap enough to check after every case. */
async function schemaDigest(sql: Query) {
  const parts = SNAPSHOT_SQL.map(([kind, text]) =>
    `select '${kind}' kind, md5(coalesce(string_agg(md5(row_to_json(x)::text), '' order by x.key), '')) d from (${text}) x`);
  return (await sql.query(parts.join(' union all '))).rows.map(row => `${row.kind}:${row.d}`).join(',');
}

/**
 * Local test tool only: it rewrites schema objects. Refuse anything but the
 * isolated runner's disposable database, never a remote or shared one.
 */
async function assertDisposable(sql: Query) {
  const url = process.env.V3_LOCAL_DB ?? '';
  const database = (await sql.query('select current_database() name')).rows[0]?.name;
  if (!url.startsWith('postgres://postgres@127.0.0.1:') || !url.endsWith('/v3_disposable') || database !== 'v3_disposable')
    throw new Error('SCHEMA_SNAPSHOT_LOCAL_ONLY');
}

export async function snapshotSchema(sql: Query) {
  await assertDisposable(sql);
  const before = await capture(sql);
  return () => restore(sql, before);
}

/**
 * File-wide guard: take the baseline once, then after each case restore any
 * schema change and fail that case if it cannot be restored exactly.
 */
export async function schemaGuard(sql: Query) {
  await assertDisposable(sql);
  const baseline = await capture(sql), expected = await schemaDigest(sql);
  return async () => { if (await schemaDigest(sql) !== expected) await restore(sql, baseline); };
}
