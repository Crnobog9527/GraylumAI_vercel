/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REVIEW-COACH RC-0 command line. Prints to stdout and never connects to any database:
//   node packages/db/tests/publish-monitor-coach/seed.mjs json [--as-of 2026-10-27] [--seed 20261027] > dataset.json
//   node packages/db/tests/publish-monitor-coach/seed.mjs sql --actor <user uuid> --business A=<brand uuid> [...] > seed.sql
//   node packages/db/tests/publish-monitor-coach/seed.mjs remove --actor <user uuid> > remove.sql
// Applying seed.sql or remove.sql to staging is a staging write: tell the controller first (AGENTS.md section 8).
import { generateDataset } from '../../../api/src/services/publishMonitor/coach/simulatedDataset.ts';
import { removeSql, seedSql } from './seed-sql.mjs';

const [command, ...rest] = process.argv.slice(2);
const options = { business: {} };
for (let i = 0; i < rest.length; i += 2) {
  const [flag, value] = [rest[i], rest[i + 1]];
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  if (flag === '--business') {
    const [key, id] = value.split('=');
    options.business[key] = id;
  } else if (['--as-of', '--seed', '--actor'].includes(flag)) {
    options[flag.slice(2)] = value;
  } else throw new Error(`unknown option ${flag}`);
}
const dataset = () => generateDataset({ asOf: options['as-of'], seed: options.seed === undefined ? undefined : Number(options.seed) });
if (command === 'json') process.stdout.write(JSON.stringify(dataset(), null, 1) + '\n');
else if (command === 'sql') {
  if (!Object.keys(options.business).length) throw new Error('at least one --business <A|B|C|D>=<uuid> is required');
  process.stdout.write(seedSql(dataset(), options.actor ?? '', options.business) + '\n');
} else if (command === 'remove') process.stdout.write(removeSql(options.actor ?? '') + '\n');
else {
  process.stderr.write('usage: seed.mjs json|sql|remove [options]; see the header of this file\n');
  process.exit(2);
}
