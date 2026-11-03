import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resultsDirectory } from './config';

/** Turns spend.json into a short markdown summary for the job log and the failure issue. */
export default async function teardown() {
  try {
    const spend = JSON.parse(await readFile(path.join(resultsDirectory, 'spend.json'), 'utf8')) as {
      capUsd: number; totalUsd: number; baselineUsd?: number; journeys: Array<{ label: string; usd: number }>;
    };
    // Daily mode counts the whole UTC day: the baseline is what earlier runs of the day had spent.
    const baseline = spend.baselineUsd ?? 0;
    const lines = [`# Core-path run`, '', baseline > 0
      ? `Spend: this run $${(spend.totalUsd - baseline).toFixed(4)}; today $${spend.totalUsd.toFixed(4)} of $${spend.capUsd.toFixed(2)}`
      : `Spend: $${spend.totalUsd.toFixed(4)} of $${spend.capUsd.toFixed(2)}`, '',
      ...spend.journeys.map(entry => `- ${entry.label}: $${entry.usd.toFixed(4)}`)];
    const daily = await readFile(path.join(resultsDirectory, 'daily-turns.json'), 'utf8')
      .then(text => JSON.parse(text) as { turns: Array<{ id: string; kind: string; closeKind: string | null; charged: number | null; reserved: number }> }, () => null);
    if (daily) lines.push('', 'Turns:', '', ...daily.turns.map(turn => `- ${turn.kind} ${turn.id}: ${turn.closeKind}, charged ${turn.charged ?? 0} of ${turn.reserved}`));
    const breakdown = await readFile(path.join(resultsDirectory, 'spend-breakdown.json'), 'utf8')
      .then(text => JSON.parse(text) as { modelsUsd: number; suppliersUsd: number; routes: Array<{ route: string; calls: number; usd: number }> }, () => null);
    if (breakdown) {
      lines.push('', `Models: $${breakdown.modelsUsd.toFixed(4)}; search suppliers: $${breakdown.suppliersUsd.toFixed(4)}`, '',
        ...breakdown.routes.map(row => `- ${row.route}: ${row.calls} calls, $${row.usd.toFixed(4)}`));
    }
    await writeFile(path.join(resultsDirectory, 'summary.md'), `${lines.join('\n')}\n`);
  } catch {
    await writeFile(path.join(resultsDirectory, 'summary.md'), '# Core-path run\n\nNo spend report was written.\n').catch(() => undefined);
  }
}
