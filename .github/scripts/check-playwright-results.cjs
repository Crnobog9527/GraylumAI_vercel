/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

'use strict';

const fs = require('node:fs');

const argumentsList = process.argv.slice(2);
const allowSkipped = argumentsList.includes('--allow-skipped');
const positionalArguments = argumentsList.filter((argument) => argument !== '--allow-skipped');

if (positionalArguments.length !== 1) {
  console.error('Usage: check-playwright-results.cjs <report.json> [--allow-skipped]');
  process.exit(1);
}

const reportPath = positionalArguments[0];
let report;

try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to read a valid Playwright JSON report: ${message}`);
  process.exit(1);
}

const resultStatuses = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const overallStatuses = new Set(['expected', 'unexpected', 'flaky', 'skipped']);
const unstableAttemptStatuses = new Set(['failed', 'timedOut', 'interrupted']);
const counts = {
  passed: 0,
  failed: 0,
  timedOut: 0,
  skipped: 0,
  interrupted: 0,
  flaky: 0,
  unknown: 0,
};

function countTest(test) {
  const results = Array.isArray(test.results) ? test.results : [];
  const statuses = results.map((result) => result?.status ?? 'unknown');

  if (statuses.length === 0 || statuses.some((status) => !resultStatuses.has(status))) {
    counts.unknown += 1;
    return;
  }

  const finalStatus = statuses.at(-1);
  const overallStatus = test.status;
  const recoveredFailure = statuses.slice(0, -1).some((status) => unstableAttemptStatuses.has(status));

  if (
    recoveredFailure ||
    overallStatus === 'flaky' ||
    (overallStatus !== undefined && !overallStatuses.has(overallStatus))
  ) {
    counts.flaky += 1;
    return;
  }

  if (overallStatus === 'unexpected' && finalStatus === 'passed') {
    counts.unknown += 1;
    return;
  }

  if (Object.hasOwn(counts, finalStatus)) {
    counts[finalStatus] += 1;
  } else {
    counts.unknown += 1;
  }
}

function visitSuite(suite) {
  for (const spec of suite?.specs ?? []) {
    for (const test of spec?.tests ?? []) {
      countTest(test);
    }
  }

  for (const child of suite?.suites ?? []) {
    visitSuite(child);
  }
}

for (const suite of report?.suites ?? []) {
  visitSuite(suite);
}

const executed =
  counts.passed +
  counts.failed +
  counts.timedOut +
  counts.interrupted +
  counts.flaky +
  counts.unknown;

console.log(
  'Transitional Playwright result summary ' +
    `(executed=${executed} passed=${counts.passed} failed=${counts.failed} ` +
    `timedOut=${counts.timedOut} skipped=${counts.skipped} interrupted=${counts.interrupted} ` +
    `flaky=${counts.flaky} unknown=${counts.unknown}).`,
);
console.log('This result does not prove Trusted Staging E2E or complete security coverage.');

if (executed === 0) {
  console.error('No Playwright tests executed.');
  process.exit(1);
}

if (!allowSkipped && counts.skipped > 0) {
  console.error('Skipped Playwright tests are forbidden for this run.');
  process.exit(1);
}

if (
  counts.failed > 0 ||
  counts.timedOut > 0 ||
  counts.interrupted > 0 ||
  counts.flaky > 0 ||
  counts.unknown > 0
) {
  console.error('Playwright results contain unstable, failed, interrupted, timed out, or unknown outcomes.');
  process.exit(1);
}
