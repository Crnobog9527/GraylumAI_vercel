/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  join(__dirname, '../../db/migrations/0062_skill_1a_db_publish_contract.sql'),
  'utf8',
);
const schemaSource = readFileSync(join(__dirname, '../../db/schema.ts'), 'utf8');

describe('SKILL-1A migration 0062', () => {
  it('defines the expand-only schema and nullable inactive module binding', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS public.skills');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS public.skill_revisions');
    expect(migrationSql).toContain('CONSTRAINT skills_skill_key_key UNIQUE (skill_key)');
    expect(migrationSql).toContain('CONSTRAINT skill_revisions_skill_id_version_key UNIQUE (skill_id, version)');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS skill_id UUID');
    expect(migrationSql).toContain('ALTER COLUMN active SET DEFAULT FALSE');
    expect(migrationSql).not.toMatch(/UPDATE\s+public\.modules/i);
  });

  it('locks before append-only version creation and hashes the published draft', () => {
    const lock = migrationSql.indexOf('FOR UPDATE;');
    const insertRevision = migrationSql.indexOf('INSERT INTO public.skill_revisions');
    const publishUpdate = migrationSql.indexOf('UPDATE public.skills');

    expect(lock).toBeGreaterThan(0);
    expect(insertRevision).toBeGreaterThan(lock);
    expect(publishUpdate).toBeGreaterThan(insertRevision);
    expect(migrationSql).toContain('v_next_version := v_skill.published_version + 1');
    expect(migrationSql).toContain("encode(sha256(convert_to(v_skill.draft_content, 'UTF8')), 'hex')");
    expect(migrationSql).toContain('skill draft content must not be empty');
  });

  it('enforces immutable keys and revision history without version rollback', () => {
    expect(migrationSql).toContain('skill_key is immutable');
    expect(migrationSql).toContain('published_version cannot decrease');
    expect(migrationSql).toContain('published_version must increase by exactly one');
    expect(migrationSql).toContain('published skill revisions are immutable');
    expect(migrationSql).toContain('BEFORE UPDATE OR DELETE ON public.skill_revisions');
  });

  it('exposes only published columns and keeps publishing service-role-only', () => {
    expect(migrationSql).toContain('TO anon, authenticated');
    expect(migrationSql).toContain("status = 'published'");
    expect(migrationSql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*draft_content[^;]*TO\s+(?:anon|authenticated)/i);
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION public.atomic_publish_skill(UUID, UUID, JSONB)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.atomic_publish_skill(UUID, UUID, JSONB)\n  TO service_role;',
    );
    expect(migrationSql).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
  });

  it('keeps schema.ts aligned with the migration contract', () => {
    expect(schemaSource).toContain("export const skills = pgTable('skills'");
    expect(schemaSource).toContain("export const skillRevisions = pgTable('skill_revisions'");
    expect(schemaSource).toContain("skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' })");
    expect(schemaSource).toContain("active: boolean('active').default(false).notNull()");
  });
});
