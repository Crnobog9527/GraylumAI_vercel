import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resultsDirectory } from './config';

/** Turns spend.json into a short markdown summary for the job log and the failure issue. */
export default async function teardown() {
  try {
    const spend = JSON.parse(await readFile(path.join(resultsDirectory, 'spend.json'), 'utf8')) as {
      capUsd: number; totalUsd: number; journeys: Array<{ label: string; usd: number }>;
    };
    const lines = [`# Core-path run`, '', `Spend: $${spend.totalUsd.toFixed(4)} of $${spend.capUsd.toFixed(2)}`, '',
      ...spend.journeys.map(entry => `- ${entry.label}: $${entry.usd.toFixed(4)}`)];
    await writeFile(path.join(resultsDirectory, 'summary.md'), `${lines.join('\n')}\n`);
  } catch {
    await writeFile(path.join(resultsDirectory, 'summary.md'), '# Core-path run\n\nNo spend report was written.\n').catch(() => undefined);
  }
}
