/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installAdminSurfacesPreview } from './admin-surfaces-fixture.mjs';

const root = resolve(import.meta.dirname, '../../../..');

test('profile preview installs check-in reads without exposing reward writes', () => {
  const statements = [];
  installAdminSurfacesPreview((sql) => statements.push(sql), root);
  const sql = statements.join('\n');
  const migration = readFileSync(resolve(root, 'packages/db/migrations/0013_checkin_rewards.sql'), 'utf8');
  const policy = migration.match(/CREATE POLICY "users_own_user_checkins_select"[\s\S]*?;/)?.[0];
  assert.ok(policy);
  assert.ok(statements.includes(policy), 'copy the complete read policy from the migration');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_checkins\s*\(/);
  assert.match(sql, /ALTER TABLE user_checkins ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON user_checkins FROM PUBLIC,anon,authenticated;/);
  assert.match(sql, /GRANT SELECT ON user_checkins TO authenticated;/);
  assert.doesNotMatch(sql, /claim_daily_checkin|users_own_user_checkins_insert|admin_all_user_checkins/);
});

test('check-in table and both indexes match the authoritative migration byte-for-byte', () => {
  const statements = [];
  installAdminSurfacesPreview((sql) => statements.push(sql), root);
  const sql = statements.join('\n');
  const migration = readFileSync(resolve(root, 'packages/db/migrations/0013_checkin_rewards.sql'), 'utf8');
  const ddl = migration.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS [\s\S]*?;/g);
  assert.equal(ddl?.length, 3);
  for (const statement of ddl) assert.ok(sql.includes(statement), 'copy the complete migration DDL');
  assert.match(sql, /checkin_date DATE NOT NULL/);
  assert.match(sql, /CHECK \(streak_day BETWEEN 1 AND 5\)/);
});
