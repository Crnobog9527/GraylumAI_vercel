/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Splits the database suites over N CI jobs by measured duration (suite-durations.json): longest suite first, always into the lightest
// shard (ties: lower shard number). Deterministic for a given suite list, so every job computes the same split; a suite missing from the
// file weighs defaultSeconds. Every suite lands in exactly one shard. Refresh the file from the "Database suites K/N" step summaries.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const loadDurations = (dir = import.meta.dirname) =>
  JSON.parse(readFileSync(resolve(dir, 'suite-durations.json'), 'utf8'));

// Returns the suites of shard K (1-based) of N, in alphabetical order.
export function suitesForShard(suites, shard, shards, durations = loadDurations()) {
  const weight = suite => durations.seconds[suite] ?? durations.defaultSeconds;
  const load = Array.from({ length: shards }, () => 0);
  const mine = [];
  for (const suite of [...suites].sort((x, y) => weight(y) - weight(x) || x.localeCompare(y))) {
    const target = load.indexOf(Math.min(...load));
    load[target] += weight(suite);
    if (target === shard - 1) mine.push(suite);
  }
  return mine.sort();
}
