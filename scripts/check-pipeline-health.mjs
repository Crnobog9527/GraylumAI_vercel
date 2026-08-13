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
 *      reports?  A required context that never reports blocks every pull
 *      request into the branch, forever, with no failure to look at.
 *   3. Which pull requests are actually blocked, and on what?
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
const PR_SAMPLE_FOR_CONTEXT_EVIDENCE = 20;

// A required context is satisfied by any of these conclusions.  `skipped` and
// `neutral` count: GitHub treats them as passing for branch protection.
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

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

/** Branch protection, fetched once per branch. */
const protectionCache = new Map();

function getProtection(repo, branch) {
  if (protectionCache.has(branch)) return protectionCache.get(branch);

  let result;
  try {
    const protection = gh(`repos/${repo}/branches/${branch}/protection`);
    result = { required: protection.required_status_checks?.contexts ?? [], error: null, absent: false };
  } catch (error) {
    // Fail closed on anything that is not "there is genuinely no protection".
    // A permission or API error means the audit did not run; reporting OK in
    // that case reproduces the exact failure this script exists to catch.
    result = { required: [], error: error.notFound ? null : error, absent: error.notFound };
  }
  protectionCache.set(branch, result);
  return result;
}

/** Every check name that reported on a commit, with its conclusion. */
function reportedChecks(repo, sha) {
  const runs = gh(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).check_runs ?? [];
  const statuses = gh(`repos/${repo}/commits/${sha}/status`).statuses ?? [];

  const byName = new Map();
  // Newest wins: a name can be reported more than once on the same commit
  // (a push run and a pull_request run both target the head SHA).
  for (const run of [...runs].sort((a, b) => new Date(a.completed_at ?? 0) - new Date(b.completed_at ?? 0))) {
    byName.set(run.name, { conclusion: run.conclusion, status: run.status });
  }
  for (const status of [...statuses].sort(
    (a, b) => new Date(a.updated_at ?? a.created_at ?? 0) - new Date(b.updated_at ?? b.created_at ?? 0),
  )) {
    byName.set(status.context, normalizeCommitStatus(status));
  }
  return byName;
}

/** GitHub commit-status states: error | failure | pending | success. */
function normalizeCommitStatus(status) {
  if (status.state === 'pending') {
    // Keep in-flight semantics, matching how an in-progress check run is
    // treated.  A legacy status integration mid-deploy is not a failure.
    return { conclusion: null, status: 'in_progress' };
  }
  return {
    conclusion: status.state === 'success' ? 'success' : 'failure',
    status: 'completed',
  };
}

/**
 * Contexts observed on recent pull requests into a branch.
 *
 * Some required checks are pull-request-only by design — this repository's
 * `Dependency Review` job is gated on `github.event_name == 'pull_request'` —
 * so they never appear on the protected branch's HEAD while reporting normally
 * on every pull request.  Comparing against HEAD alone would call them phantom
 * and claim the branch is permanently blocked when it is not.
 */
function lastWorkflowChangeAt(repo, branch) {
  const commits = gh(`repos/${repo}/commits?sha=${branch}&path=.github/workflows&per_page=1`);
  return commits[0]?.commit?.committer?.date ?? null;
}

function contextsSeenOnRecentPullRequests(repo, branch, workflowChangedAt) {
  const seen = new Set();
  const evidence = new Map();
  let eligiblePulls = 0;
  let pulls;
  try {
    pulls = gh(`repos/${repo}/pulls?state=all&base=${branch}&per_page=${PR_SAMPLE_FOR_CONTEXT_EVIDENCE}&sort=updated&direction=desc`);
  } catch {
    return { seen, evidence, eligiblePulls };
  }
  for (const pull of pulls) {
    if (workflowChangedAt && new Date(pull.created_at) <= new Date(workflowChangedAt)) continue;
    if (!workflowChangedAt) continue;
    eligiblePulls += 1;
    try {
      for (const name of reportedChecks(repo, pull.head.sha).keys()) {
        seen.add(name);
        if (!evidence.has(name)) evidence.set(name, { number: pull.number, createdAt: pull.created_at });
      }
    } catch {
      // A single unreadable pull request must not sink the audit; the caller
      // only ever uses this set to *withdraw* a phantom accusation.
    }
  }
  return { seen, evidence, eligiblePulls };
}

function auditRequiredChecks(repo, branch) {
  const { required, error, absent } = getProtection(repo, branch);

  if (error) {
    problem(
      `${branch}: could not read branch protection, so the phantom required-check audit did NOT run — ${error.message}`,
    );
    return;
  }
  if (absent) {
    notes.push(`${branch}: no branch protection configured`);
    return;
  }
  if (required.length === 0) {
    notes.push(`${branch}: no required status checks configured`);
    return;
  }

  const head = gh(`repos/${repo}/branches/${branch}`).commit.sha;
  const onHead = reportedChecks(repo, head);
  const missingOnHead = required.filter((context) => !onHead.has(context));

  if (missingOnHead.length === 0) {
    notes.push(`${branch}: all ${required.length} required status check(s) reported on HEAD — no phantom contexts`);
    return;
  }

  const workflowChangedAt = lastWorkflowChangeAt(repo, branch);
  const { seen: onPullRequests, evidence, eligiblePulls } = contextsSeenOnRecentPullRequests(
    repo,
    branch,
    workflowChangedAt,
  );
  const pullRequestOnly = missingOnHead.filter((context) => onPullRequests.has(context));
  const phantom = missingOnHead.filter((context) => !onPullRequests.has(context));

  if (pullRequestOnly.length > 0) {
    for (const context of pullRequestOnly) {
      const item = evidence.get(context);
      notes.push(
        `${branch}: ${context} is pull-request-only — last seen on #${item.number} ` +
          `(created ${item.createdAt}, after the last workflow change${workflowChangedAt ? ` (${workflowChangedAt})` : ''})`,
      );
    }
  }
  if (phantom.length > 0) {
    if (eligiblePulls === 0) {
      problem(
        `${branch}: ${phantom.length} required check(s) missing from HEAD and no pull request created since the last ` +
          `workflow change (${workflowChangedAt ?? 'unknown'}) to confirm them — treat as phantom until a new pull request ` +
          `reports them: ${phantom.join(', ')}`,
      );
    } else {
      problem(
        `${branch}: ${phantom.length} required status check(s) reported neither on HEAD (${head.slice(0, 7)}) nor on ` +
          `the last ${PR_SAMPLE_FOR_CONTEXT_EVIDENCE} eligible pull requests — every pull request into ${branch} will block ` +
          `forever with no failure to inspect: ${phantom.join(', ')}`,
      );
    }
  } else {
    notes.push(`${branch}: all ${required.length} required status check(s) accounted for — no phantom contexts`);
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

/**
 * Open pull requests, judged on their required checks rather than their age.
 *
 * Age is a poor proxy in both directions: a pull request opened an hour ago can
 * already be permanently blocked on a required check that will never report,
 * and a backlog of old-but-healthy pull requests is a scheduling matter, not a
 * pipeline failure.
 */
function auditOpenPullRequests(repo) {
  const pulls = gh(`repos/${repo}/pulls?state=open&per_page=100`, { paginate: true });
  if (pulls.length === 0) {
    notes.push('no open pull requests');
    return;
  }

  const blocked = [];
  const stale = [];

  for (const pull of pulls) {
    const { required, error, absent } = getProtection(repo, pull.base.ref);
    if (error || absent || required.length === 0) continue;

    let checks;
    try {
      checks = reportedChecks(repo, pull.head.sha);
    } catch {
      continue;
    }

    const neverReported = required.filter((context) => !checks.has(context));
    const failing = required.filter((context) => {
      const check = checks.get(context);
      return check && check.status === 'completed' && !PASSING_CONCLUSIONS.has(check.conclusion);
    });

    if (neverReported.length > 0 || failing.length > 0) {
      blocked.push({ pull, neverReported, failing, age: daysSince(pull.created_at) });
    } else if (daysSince(pull.created_at) >= 30) {
      stale.push({ pull, age: daysSince(pull.created_at) });
    }
  }

  notes.push(`${pulls.length} open pull request(s); ${blocked.length} blocked on required checks`);

  for (const entry of blocked.sort((a, b) => b.age - a.age).slice(0, 10)) {
    const reasons = [
      entry.failing.length > 0 ? `failing: ${entry.failing.join(', ')}` : null,
      entry.neverReported.length > 0 ? `never reported: ${entry.neverReported.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    notes.push(`  #${entry.pull.number} →${entry.pull.base.ref} ${entry.age}d — ${reasons}`);
  }

  if (blocked.length > 0) {
    problem(`${blocked.length} open pull request(s) cannot merge: required checks are failing or never report`);
  }
  if (stale.length > 0) {
    notes.push(`${stale.length} mergeable pull request(s) older than 30 days are waiting on a human`);
  }
}

/** Scheduled runs are the canary nobody watches. */
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
    // An in-progress run has a null conclusion.  Left in place it reads as
    // "not a failure" and hides however many consecutive failures precede it.
    const ordered = [...workflowRuns]
      .filter((run) => run.status === 'completed')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (ordered.length === 0) continue;

    const firstNonFailure = ordered.findIndex((run) => run.conclusion !== 'failure');
    const streak = firstNonFailure === -1 ? ordered.length : firstNonFailure;
    const name = ordered[0].name;

    if (streak >= 2) {
      problem(
        `${production}: scheduled workflow "${name}" has failed ${streak} completed run(s) in a row ` +
          `(most recent ${ordered[0].html_url})`,
      );
    } else if (streak === 1) {
      notes.push(
        `${production}: scheduled workflow "${name}" failed its most recent completed run (${ordered[0].html_url})`,
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
  auditOpenPullRequests(repo);
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
