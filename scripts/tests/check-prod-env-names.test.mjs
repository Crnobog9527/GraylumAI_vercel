/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  FORBIDDEN_ALWAYS,
  REQUIRED_ALWAYS,
  WARN_MISSING_LATER,
  checkNames,
  parseNames,
} from '../check-prod-env-names.mjs';

const base = () => new Set(REQUIRED_ALWAYS);

test('build phase passes with exactly the required names', () => {
  const { errors } = checkNames(base(), 'build');
  assert.deepEqual(errors, []);
});

test('a missing required name fails', () => {
  const names = base();
  names.delete('TURN_DATABASE_HOST');
  assert.ok(checkNames(names, 'build').errors.some((e) => e.includes('TURN_DATABASE_HOST')));
});

test('forbidden staging and test names fail, including prefixes', () => {
  for (const bad of ['V3_RUNTIME_STAGING_ENABLED', 'WAFFO_TEST_KEY', 'LOADTEST_TOKEN', 'OPENROUTER_API_KEY']) {
    const names = base().add(bad);
    assert.ok(checkNames(names, 'smoke').errors.some((e) => e.includes(bad)), bad);
  }
});

test('coach package is absent at build, required afterwards', () => {
  const withPkg = base().add('PUBLISH_MONITOR_HANDBOOK_PACKAGE');
  assert.ok(checkNames(withPkg, 'build').errors.some((e) => e.includes('PUBLISH_MONITOR_HANDBOOK_PACKAGE')));
  assert.deepEqual(checkNames(withPkg, 'smoke').errors, []);
  assert.ok(checkNames(base(), 'smoke').errors.some((e) => e.includes('PUBLISH_MONITOR_HANDBOOK_PACKAGE')));
});

test('SITE_INDEXING is set only for public opening, and E2E names go away', () => {
  const smoke = base().add('PUBLISH_MONITOR_HANDBOOK_PACKAGE').add('SITE_INDEXING');
  assert.ok(checkNames(smoke, 'smoke').errors.some((e) => e.includes('SITE_INDEXING')));
  const pub = base().add('PUBLISH_MONITOR_HANDBOOK_PACKAGE').add('SITE_INDEXING');
  assert.deepEqual(checkNames(pub, 'public').errors, []);
  assert.ok(checkNames(pub.add('E2E_TEST_PASSWORD'), 'public').errors.some((e) => e.includes('E2E_TEST_PASSWORD')));
  assert.ok(checkNames(base().add('PUBLISH_MONITOR_HANDBOOK_PACKAGE'), 'public').errors.some((e) => e.includes('SITE_INDEXING')));
});

test('missing promo flag is only a warning after build', () => {
  const names = base().add('PUBLISH_MONITOR_HANDBOOK_PACKAGE');
  const { errors, warnings } = checkNames(names, 'smoke');
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(WARN_MISSING_LATER[0])));
});

test('parseNames keeps names only and ignores values and comments', () => {
  const names = parseNames('# comment\nCRON_SECRET=should-not-matter\nSENTRY_ORG   Production  Encrypted\n\n9not-a-name line\n');
  assert.deepEqual([...names].sort(), ['CRON_SECRET', 'SENTRY_ORG']);
});

test('the CLI never echoes a value and exits non-zero on failure', () => {
  let out = '';
  try {
    execFileSync('node', ['scripts/check-prod-env-names.mjs', '--phase', 'build', '/dev/stdin'], {
      input: 'CRON_SECRET=super-secret-value\n',
      encoding: 'utf8',
    });
    assert.fail('expected a non-zero exit');
  } catch (error) {
    out = String(error.stdout);
    assert.equal(error.status, 1);
  }
  assert.ok(!out.includes('super-secret-value'));
  assert.ok(out.includes('FAIL missing required variable'));
});

test('every listed name still appears in the code', () => {
  const names = [...REQUIRED_ALWAYS, 'SITE_INDEXING', 'PUBLISH_MONITOR_HANDBOOK_PACKAGE', ...WARN_MISSING_LATER];
  const stale = names.filter((name) => {
    try {
      execFileSync(
        'git',
        ['grep', '-q', '-w', name, '--', 'apps', 'packages', 'scripts', ':!*.md', ':!scripts/check-prod-env-names.mjs', ':!scripts/tests/check-prod-env-names.test.mjs'],
        { stdio: 'ignore' },
      );
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(stale, [], 'names that no code reads any more; update the list and REL-1-BUILD-PREP');
  assert.ok(FORBIDDEN_ALWAYS.length > 0);
});
