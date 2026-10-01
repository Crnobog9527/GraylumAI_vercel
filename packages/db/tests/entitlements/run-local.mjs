/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// One isolated local Docker replay. Never uses DB URLs, env files, or remote connections.
import { spawnSync } from 'node:child_process';
import { installAdminSurfacesPreview } from '../v3/admin-surfaces-fixture.mjs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

if (process.argv[2] !== '--local-only' || process.env.CI) throw new Error('Use --local-only outside CI');
const root = resolve(import.meta.dirname, '../../../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const dir = 'packages/db/tests/entitlements';
const names = readdirSync(resolve(root, 'packages/db/migrations')).filter(name => /^\d{4}_membership_entitlements\.sql$/.test(name));
if (names.length !== 1) throw new Error('Expected exactly one ENTITLEMENTS migration');
const migration = read(`packages/db/migrations/${names[0]}`);
const migrationBody = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const objectQuery = `${fingerprint.slice(0, fingerprint.indexOf('-- FINAL'))}SELECT jsonb_object_agg(k,d ORDER BY k) AS value FROM grouped;`;
const temp = mkdtempSync(resolve(tmpdir(), 'graylum-entitlements-db-'));
const write = (name, sql) => { const path = resolve(temp, name); writeFileSync(path, sql); return path; };
try {
  const cases = write('cases.sql', [
    `CREATE TEMP TABLE entitlements_schema_before AS ${objectQuery}`,
    read(`${dir}/rollback.sql`),
    `CREATE TEMP TABLE entitlements_rollback_before AS ${objectQuery}`,
    read(`${dir}/seed.sql`), migration, read(`${dir}/cases.sql`), migration,
    ...['unknown', 'free'].map(level => `DO $probe$ BEGIN
      ALTER TABLE public.membership_plans DROP CONSTRAINT membership_plans_level_key;
      INSERT INTO public.membership_plans
        (name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
        VALUES ('invalid local fixture','${level}',false,false,0);
      EXECUTE $migration$${migrationBody}$migration$;
      RAISE EXCEPTION 'migration accepted unknown or duplicate tier';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'ENTITLEMENTS_PLAN_CONFIGURATION_REQUIRES_REVIEW' THEN RAISE; END IF;
    END $probe$;`),
    `CREATE TEMP TABLE entitlements_schema_after AS ${objectQuery}`,
    `DO $$ BEGIN
      IF (SELECT value FROM entitlements_schema_before) <> (SELECT value FROM entitlements_schema_after)
        THEN RAISE EXCEPTION 'reapply changed structure'; END IF;
      IF (SELECT allow_fusion_review FROM public.membership_plans WHERE level='pro') IS DISTINCT FROM false
        OR (SELECT library_storage_bytes FROM public.membership_plans WHERE level='pro') <> 123
        OR (SELECT value FROM public.system_settings WHERE key='fusion_compare_max_models') <> '8'::jsonb
        THEN RAISE EXCEPTION 'reapply overwrote administrator edits'; END IF;
    END $$;`,
    read(`${dir}/rollback.sql`),
    `CREATE TEMP TABLE entitlements_rollback_after AS ${objectQuery}`,
    `DO $$ BEGIN
      IF (SELECT value FROM entitlements_rollback_before) <> (SELECT value FROM entitlements_rollback_after)
        THEN RAISE EXCEPTION 'rollback changed unrelated structure'; END IF;
      IF (SELECT count(*) FROM public.membership_plans) <> 3
        THEN RAISE EXCEPTION 'rollback lost plans'; END IF;
    END $$;`, migration,
  ].join('\n'));
  const clients = ['anon', 'authenticated'].map(role => write(`${role}.sql`, `
    SET ROLE ${role};
    SELECT set_config('request.jwt.claims',
      '{"sub":"00000000-0000-4000-8000-00000000e001","role":"${role}"}',false);
    ${read(`${dir}/client.sql`)}`));
  // Exercise the existing disposable preview fixture after the ACL tests; remove only
  // this runner's synthetic plans and its already-installed public read policies first.
  const previewStatements = [`SET client_min_messages = warning;
    DELETE FROM public.membership_plans;
    DROP POLICY IF EXISTS users_own_user_checkins_select ON public.user_checkins;
    DROP POLICY IF EXISTS announcements_select_active_public ON public.announcements;
    DROP POLICY IF EXISTS membership_plans_select_active_public ON public.membership_plans;
    DROP POLICY IF EXISTS credit_packages_select_active_public ON public.credit_packages;`];
  installAdminSurfacesPreview(sql => previewStatements.push(sql), root);
  previewStatements.push(`DO $$ BEGIN
    IF (SELECT count(*) FROM membership_plans WHERE library_storage_bytes > 0) <> 3
      THEN RAISE EXCEPTION 'preview fixture entitlement defaults missing'; END IF;
  END $$;`);
  const preview = write('preview-fixture.sql', previewStatements.join('\n'));
  const stagingSeed = write('staging-seed.sql', [
    'DELETE FROM public.membership_plans;',
    read('packages/db/seeds/staging_non_secret_baseline.sql'),
    read(`${dir}/staging-seed-first.sql`),
    read('packages/db/seeds/staging_non_secret_baseline.sql'),
    read(`${dir}/staging-seed-replay.sql`),
  ].join('\n'));
  const result = spawnSync('node', ['packages/db/tests/run-db-baseline-replay.mjs', '--local-only',
    '--out', resolve(temp, 'fingerprint.json'), '--after', [cases, ...clients, `${dir}/service.sql`, `${dir}/closed-client.sql`, preview,
      'packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql', stagingSeed].join(',')], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
