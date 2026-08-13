#!/usr/bin/env node
/**
 * Read-only release pipeline health report.
 *
 * Answers the questions nobody was asking while `main` sat frozen for five
 * weeks behind a required status check that no workflow on `main` could ever
 * produce:
 *
 *   1. How far behind is the production branch, and how long has it been stale?
 *   2. Does every required status check correspond to a check that actually
 *      reports on that branch?  (A required context that never reports blocks
 *      every pull request into the branch, forever, with no failure to look at.)
 *   3. Which pull requests are stuck on required checks?
 *   4. Are scheduled workflow runs failing?
 *
 * Deliberately read-only and deliberately not a GitHub Actions workflow: the
 * repository workflow policy (.github/scripts/check-workflow-policy.rb) forbids
 * write permissions in workflows, and an alerting workflow would need
 * `issues: write`.  Run it locally or from an agent session instead.
 *
 * Usage:
 *   node scripts/check-pipeline-health.mjs
 *   node scripts/check-pipeline-health.mjs --production main --integration staging
 *
 * Exit code 0 when healthy, 1 when any problem is reported.
 */

import { execFileSync } from 'node:child_process';

const STALE_PRODUCTION_DAYS = 7;

function parseArgs(argv) {
  const args = { production: 'main', integration: 'staging' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--production') args.production = argv[i + 1];
    if (argv[i] === '--integration') args.integration = argv[i + 1];
  }
  return args;
}

function gh(path, { paginate = false } = {}) {
  // `gh api --paginate` emits one independent JSON document per page, which
  // JSON.parse cannot consume once a request spans more than one page.
  // `--slurp` wraps the pages in a single outer array; flatten it back to the
  // shape a single-page response would have.
  const argv = ['api'];
  if (paginate) argv.push('--paginate', '--slurp');
  argv.push(path);
  try {
    const raw = execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(raw);
    return paginate ? parsed.flat() : parsed;
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? '';
    const wrapped = new Error(`gh api ${path} failed: ${stderr || error.message}`);
    wrapped.stderr = stderr;
    wrapped.notFound = /HTTP 404|Not Found/i.test(stderr);
    throw wrapped;
  }
}

function repoSlug() {
  const raw = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' });
  return JSON.parse(raw).nameWithOwner;
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const problems = [];
const notes = [];

function problem(message) {
  problems.push(message);
}

/** Required contexts vs. contexts that actually report on the branch head. */
function auditRequiredChecks(repo, branch) {
  let protection;
  try {
    protection = gh(`repos/${repo}/branches/${branch}/protection`);
  } catch (error) {
    if (error.notFound) {
      notes.push(`${branch}: no branch protection configured`);
    } else {
      // Fail closed.  A permission or API error means the phantom required-check
      // audit did not run at all; reporting OK in that case would reproduce the
      // exact failure this script exists to catch.
      problem(
        `${branch}: could not read branch protection, so the phantom required-check audit did NOT run — ${error.message}`,
      );
    }
    return;
  }

  const required = protection.required_status_checks?.contexts ?? [];
  if (required.length === 0) {
    notes.push(`${branch}: no required status checks configured`);
    return;
  }

  const head = gh(`repos/${repo}/branches/${branch}`).commit.sha;
  const checkRuns = gh(`repos/${repo}/commits/${head}/check-runs?per_page=100`).check_runs ?? [];
  const statuses = gh(`repos/${repo}/commits/${head}/status`).statuses ?? [];
  const reported = new Set([
    ...checkRuns.map((run) => run.name),
    ...statuses.map((status) => status.context),
  ]);

  const phantom = required.filter((context) => !reported.has(context));
  if (phantom.length > 0) {
    problem(
      `${branch}: ${phantom.length} required status check(s) never reported on HEAD (${head.slice(0, 7)}) — ` +
        `every pull request into ${branch} will block forever: ${phantom.join(', ')}`,
    );
  } else {
    notes.push(`${branch}: all ${required.length} required status check(s) reported on HEAD — no phantom contexts`);
  }
}

/** Production branch drift and staleness. */
function auditBranchDrift(repo, production, integration) {
  const comparison = gh(`repos/${repo}/compare/${production}...${integration}`);
  const behind = comparison.ahead_by;
  const ahead = comparison.behind_by;

  const productionHead = gh(`repos/${repo}/branches/${production}`);
  const committedAt = productionHead.commit.commit.committer.date;
  const age = daysSince(committedAt);

  notes.push(
    `${production} HEAD ${productionHead.commit.sha.slice(0, 7)}, last updated ${age}d ago; ` +
      `${behind} commit(s) waiting in ${integration}; ${production} has ${ahead} commit(s) not in ${integration}`,
  );

  if (age >= STALE_PRODUCTION_DAYS && behind > 0) {
    problem(
      `${production} has not been updated in ${age} days while ${behind} commit(s) wait in ${integration}`,
    );
  }

  // Commit-count drift alone is a false positive: a promotion leaves a merge
  // commit on production that integration will never contain.  Only unequal
  // trees mean the two environments would actually deploy different code, and a
  // check that fires after every release is a check nobody reads.
  if (ahead > 0) {
    const integrationHead = gh(`repos/${repo}/branches/${integration}`);
    const productionTree = productionHead.commit.commit.tree.sha;
    const integrationTree = integrationHead.commit.commit.tree.sha;
    if (productionTree !== integrationTree) {
      problem(
        `${production} has ${ahead} commit(s) missing from ${integration} and the trees differ — ` +
          `environments have drifted (back-merge ${production} into ${integration})`,
      );
    } else {
      notes.push(
        `  (${ahead} commit(s) unique to ${production} are promotion merge commits; trees are identical)`,
      );
    }
  }
}

/** Open pull requests that cannot merge. */
function auditStuckPullRequests(repo) {
  const pulls = gh(`repos/${repo}/pulls?state=open&per_page=100`, { paginate: true });
  const stuck = [];

  for (const pull of pulls) {
    const age = daysSince(pull.created_at);
    if (age < 3) continue;
    stuck.push({ number: pull.number, base: pull.base.ref, age, title: pull.title });
  }

  if (stuck.length === 0) return;

  const byBase = new Map();
  for (const pull of stuck) {
    byBase.set(pull.base, (byBase.get(pull.base) ?? 0) + 1);
  }
  const summary = [...byBase.entries()].map(([base, count]) => `${base}:${count}`).join(' ');
  notes.push(`${stuck.length} open pull request(s) older than 3 days (${summary})`);

  const oldest = stuck.sort((a, b) => b.age - a.age).slice(0, 5);
  for (const pull of oldest) {
    notes.push(`  #${pull.number} →${pull.base} ${pull.age}d ${pull.title}`);
  }

  if (stuck.length >= 10) {
    problem(`${stuck.length} open pull requests are older than 3 days — the merge queue is not draining`);
  }
}

/** Scheduled workflow runs are the canary nobody watches. */
function auditScheduledRuns(repo, production) {
  const runs = gh(`repos/${repo}/actions/runs?event=schedule&branch=${production}&per_page=50`).workflow_runs ?? [];
  if (runs.length === 0) {
    notes.push(`${production}: no scheduled workflow runs found`);
    return;
  }

  // Scheduled runs from different workflows interleave by time (security.yml
  // runs Mondays, codeql.yml runs Tuesdays).  A streak computed over the merged
  // list both invents failures that never repeated and hides real ones behind an
  // unrelated workflow's success, so group by workflow before counting.
  const byWorkflow = new Map();
  for (const run of runs) {
    const key = run.workflow_id ?? run.name;
    if (!byWorkflow.has(key)) byWorkflow.set(key, []);
    byWorkflow.get(key).push(run);
  }

  for (const workflowRuns of byWorkflow.values()) {
    const ordered = [...workflowRuns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const firstNonFailure = ordered.findIndex((run) => run.conclusion !== 'failure');
    const streak = firstNonFailure === -1 ? ordered.length : firstNonFailure;
    const name = ordered[0].name;

    if (streak >= 2) {
      problem(
        `${production}: scheduled workflow "${name}" has failed ${streak} run(s) in a row ` +
          `(most recent ${ordered[0].html_url})`,
      );
    } else if (streak === 1) {
      notes.push(
        `${production}: scheduled workflow "${name}" failed its most recent run (${ordered[0].html_url})`,
      );
    }
  }
}

function main() {
  const { production, integration } = parseArgs(process.argv.slice(2));
  const repo = repoSlug();

  console.log(`Pipeline health — ${repo}`);
  console.log(`production=${production} integration=${integration}`);
  console.log('');

  auditBranchDrift(repo, production, integration);
  auditRequiredChecks(repo, production);
  auditRequiredChecks(repo, integration);
  auditStuckPullRequests(repo);
  auditScheduledRuns(repo, production);

  for (const note of notes) console.log(note);

  if (problems.length === 0) {
    console.log('\nOK — no pipeline problems detected.');
    return 0;
  }

  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const [index, message] of problems.entries()) {
    console.log(`  ${index + 1}. ${message}`);
  }
  return 1;
}

process.exitCode = main();
