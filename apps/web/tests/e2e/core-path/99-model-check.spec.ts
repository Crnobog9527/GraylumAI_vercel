import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getE2ESql } from '../support/e2eDb';
import { CORE_ROLES, credentialsFor, resultsDirectory, TEST_MODEL_ID } from './support/config';
import { expect, test } from './support/fixtures';
import { cheapestOther, readCompareModels } from './support/models';

/**
 * Runs last. Every language-model call must be Claude Haiku 5.5, except the one other column of the compare journey,
 * which must be the cheapest other model on the compare list. Supplier tool routes are not models.
 */
test('every model call of this run was Claude Haiku 5.5', async () => {
  const { startedAt } = JSON.parse(await readFile(path.join(resultsDirectory, 'run.json'), 'utf8')) as { startedAt: string };
  const emails = CORE_ROLES.map(role => credentialsFor(role).email).filter(Boolean);
  test.skip(emails.length === 0, 'no accounts configured');
  const second = cheapestOther(await readCompareModels(getE2ESql()));
  const allowed = new Set([TEST_MODEL_ID, ...(second ? [second.modelId] : [])]);
  const rows = await getE2ESql()<Array<{ model: string }>>`
    select distinct c.model from bill2_calls c
      join bill2_runs r on r.id = c.run_id join profiles p on p.id = r.actor_id
    where p.email = any(${emails}) and r.created_at >= ${startedAt}::timestamptz
      and c.model !~ '^(tikhub|parallel|firecrawl):'`;
  expect(rows.map(row => row.model).filter(model => !allowed.has(model)), 'only Haiku 5.5 and the cheapest compare model may be called').toEqual([]);
});
