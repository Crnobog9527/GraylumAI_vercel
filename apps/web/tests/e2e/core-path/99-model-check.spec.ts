import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requireAccounts } from './support/accounts';
import { resultsDirectory, sideModelIds, testModelId } from './support/config';
import { expect, test } from './support/fixtures';
import { coreSql } from './support/db';

/**
 * Runs last. Every language-model call must be the test model (CORE_E2E_MODEL_ID), the organizer / jury-summary models
 * (CORE_E2E_SIDE_MODEL_IDS), or the one other column of the compare journey, which is the cheapest other model on the compare
 * list. Supplier tool routes are not models.
 */
test('every model call of this run was an allowed model', async () => {
  const { startedAt } = JSON.parse(await readFile(path.join(resultsDirectory, 'run.json'), 'utf8')) as { startedAt: string };
  const ids = Object.values(await requireAccounts()).map(account => account.id);
  // The compare journey records which other model it picked (and asserted to be the cheapest on the picker's list).
  const second = await readFile(path.join(resultsDirectory, 'compare-model.json'), 'utf8')
    .then(text => (JSON.parse(text) as { modelId: string }).modelId, () => null);
  const allowed = new Set([testModelId(), ...sideModelIds(), ...(second ? [second] : [])]);
  // Cost per route since the run started, models and search suppliers apart. Supplier routes are named "<vendor>:<route>".
  const rows = await coreSql()<Array<{ model: string; calls: number; usd: string }>>`
    select c.model, count(*)::int as calls, coalesce(sum(c.selected_cost_usd::numeric), 0)::text as usd from bill2_calls c
      join bill2_runs r on r.id = c.run_id
    where r.actor_id = any(${ids}::uuid[]) and r.created_at >= ${startedAt}::timestamptz
    group by c.model order by sum(c.selected_cost_usd::numeric) desc nulls last`;
  const isSupplier = (model: string) => /^(tikhub|parallel|firecrawl):/.test(model);
  const sum = (items: ReadonlyArray<{ usd: string }>) => items.reduce((total, row) => total + Number(row.usd), 0);
  await writeFile(path.join(resultsDirectory, 'spend-breakdown.json'), JSON.stringify({
    modelsUsd: sum(rows.filter(row => !isSupplier(row.model))), suppliersUsd: sum(rows.filter(row => isSupplier(row.model))),
    routes: rows.map(row => ({ route: row.model, calls: row.calls, usd: Number(row.usd), kind: isSupplier(row.model) ? 'supplier' : 'model' })),
  }, null, 2));
  expect(rows.map(row => row.model).filter(model => !isSupplier(model) && !allowed.has(model)), 'only the test model, the organizer/summary models and the other model of the compare journey may be called').toEqual([]);
});
