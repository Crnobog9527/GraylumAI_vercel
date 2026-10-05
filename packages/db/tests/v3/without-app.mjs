/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// `--without-app` runs the database/API integration subsets that CI enforces:
// no local Next application and no browser. Cases that need either are
// excluded by exact name here, and the Vitest result must match this list.

export const WITHOUT_APP_SUITES = {
  cdc: {files: ['src/scripts/cdcB2Eval.integration.ts'], prefix: 'CDC_EVAL: ', excluded: []},
  bill2: {
    files: ['src/services/bill2/billing.integration.ts'],
    prefix: 'BILL2: ',
    excluded: [],
  },
  runtime: {
    files: ['src/services/runtime/runtime.integration.ts', 'src/services/runtime/streaming.integration.ts',
      'src/services/runtime/terminalReply.integration.ts', 'src/services/runtime/historyCache.integration.ts',
      'src/services/opc/capture.integration.ts'],
    prefix: 'RUNTIME: ',
    excluded: [
      {
        name: 'RUNTIME: browser ordinary and document Skill survive refresh, actual process restart and fresh login',
        cases: 1,
        reason: 'launches a desktop Chrome and drives the local Next application, then restarts it',
      },
      {
        name: 'RUNTIME: attached organizer search=',
        cases: 3,
        reason: 'reads the persisted result through the local Next application HTTP route runtime.view',
      },
      {
        name: 'RUNTIME: actual HTTP disconnect keeps late output in original scope and killed process preserves unknown without resend',
        cases: 1,
        reason: 'disconnects from and kills the local Next application process',
      },
    ],
  },
};

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function withoutAppPattern(suite) {
  const { prefix, excluded } = WITHOUT_APP_SUITES[suite];
  const names = excluded.map(({ name }) => escape(name.slice(prefix.length)));
  return '^' + escape(prefix) + (names.length ? `(?!${names.join('|')})` : '');
}

// Fails closed: every collected case must pass, except exactly the listed ones.
export function verifyWithoutAppResults(suite, report) {
  const { files, prefix, excluded } = WITHOUT_APP_SUITES[suite];
  const errors = [];
  const counts = new Map(excluded.map(({ name }) => [name, 0]));
  const perFile = new Map(files.map((file) => [file, 0]));
  let passed = 0;
  for (const result of report?.testResults ?? []) {
    const file = files.find((candidate) => String(result.name).endsWith('/' + candidate));
    if (!file) { errors.push(`unexpected test file: ${result.name}`); continue; }
    if (result.status === 'failed') errors.push(`${file}: file failed`);
    for (const test of result.assertionResults ?? []) {
      const name = test.fullName ?? test.title;
      if (test.status === 'passed' && String(name).startsWith(prefix)) {
        passed++;
        perFile.set(file, perFile.get(file) + 1);
        continue;
      }
      const exclusion = excluded.find((entry) => String(name).startsWith(entry.name));
      if (test.status === 'skipped' && exclusion) counts.set(exclusion.name, counts.get(exclusion.name) + 1);
      else errors.push(`${file}: unexpected ${test.status} case: ${name}`);
    }
  }
  if (report?.numFailedTests !== 0) errors.push(`failed cases: ${report?.numFailedTests}`);
  for (const [file, count] of perFile) if (count === 0) errors.push(`${file}: no passing case`);
  for (const { name, cases } of excluded) {
    if (counts.get(name) !== cases) errors.push(`excluded "${name}" matched ${counts.get(name)} cases, expected ${cases}`);
  }
  const skipped = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { errors, passed, skipped, perFile: Object.fromEntries(perFile) };
}
