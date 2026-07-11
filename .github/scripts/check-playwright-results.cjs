const fs = require('node:fs');

const reportPath = process.argv[2];
const allowSkipped = process.argv.includes('--allow-skipped');

if (!reportPath) {
  console.error('Usage: check-playwright-results.cjs <report.json> [--allow-skipped]');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const counts = { passed: 0, failed: 0, skipped: 0, interrupted: 0, other: 0 };

function visitSuite(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const finalStatus = results.at(-1)?.status ?? test.status ?? 'other';
      if (Object.hasOwn(counts, finalStatus)) counts[finalStatus] += 1;
      else counts.other += 1;
    }
  }
  for (const child of suite.suites ?? []) visitSuite(child);
}

for (const suite of report.suites ?? []) visitSuite(suite);
const executed = counts.passed + counts.failed + counts.interrupted + counts.other;
console.log(`Playwright results: executed=${executed} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} interrupted=${counts.interrupted} other=${counts.other}`);

if (executed === 0) {
  console.error('No Playwright tests executed.');
  process.exit(1);
}
if (!allowSkipped && counts.skipped > 0) {
  console.error('Critical Playwright test skips are forbidden in trusted staging E2E.');
  process.exit(1);
}
if (counts.failed > 0 || counts.interrupted > 0 || counts.other > 0) process.exit(1);
