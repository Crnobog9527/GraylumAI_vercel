/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Missing reports are not passes; failed cases outrank skips, which outrank an empty run.
export function suiteState(exitCode, stats) {
  if (!stats) return exitCode === 0 ? 'not-run' : 'failed';
  if (!['expected', 'unexpected', 'skipped'].every(key => Number.isInteger(stats[key]) && stats[key] >= 0)) return 'failed';
  if (exitCode !== 0 || stats.unexpected > 0) return 'failed';
  if (stats.skipped > 0) return 'skipped';
  return stats.expected > 0 ? 'passed' : 'not-run';
}

export function releaseSuitePlan({ diagnosticSuite, operationsOnly, uiOnly, destructive }) {
  const suites = diagnosticSuite ? [diagnosticSuite] : operationsOnly ? ['admin-ops', 'security', 'user-extended', 'user-supplemental', 'admin-config']
    : uiOnly ? ['home-routing', 'auth', 'admin']
      : ['home-routing', 'auth', 'admin', 'admin-ops', 'security', 'user-extended', 'user-supplemental', 'admin-config'];
  if (destructive) {
    const index = suites.indexOf('admin-config');
    if (index < 0) throw new Error('destructive suite requires the complete rehearsal');
    suites.splice(index, 0, 'admin-destructive');
  }
  return suites;
}

export const blocksLaterConfiguration = (suite, state) => suite === 'admin-destructive' && state !== 'passed';
