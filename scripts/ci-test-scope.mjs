/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Decides whether a CI run may skip the two slow database jobs ("Run database behaviour suites" and "Run billing and recovery
// integration tests"). Everything else in CI always runs. The default is the full suite; a run skips only when it is
//   - a pull request into staging whose changed files are all on the allow-list below (Owner 2026-11-01: pure front-end and docs PRs).
// A draft pull request is judged exactly like a ready one (Owner 2026-11-03 replaced the 2026-11-01 draft skip).
// It also says whether the pull request is documentation only (docs_only): the simulated-model browser tests skip then, and only then
// (a front-end change is exactly what a browser test is for). docs_only is a subset of the allow-list (isDocsPath below) and adds
// nothing to it.
// Usage (CI): node scripts/ci-test-scope.mjs   -- reads GITHUB_EVENT_NAME / GITHUB_BASE_REF, writes full=true|false and
// docs_only=true|false to $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WEB_UI_ROOTS = ['apps/web/src/components/', 'apps/web/src/app/'];
// Never allowed, whatever the extension: server code, database, billing and permission paths, tooling, CI, dependencies.
const EXCLUDED_PREFIXES = ['apps/web/src/app/api/', 'packages/', 'supabase/', 'scripts/', '.github/'];
const SERVER_FILE = /^(route|middleware|proxy)(\.|$)/;

// True only for a clean repository-relative path; anything odd is treated as "not on the allow-list".
function cleanPath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path)) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function isSkippablePath(path) {
  if (!cleanPath(path)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  if (path.startsWith('docs/') || path.endsWith('.md')) return true;
  if (!WEB_UI_ROOTS.some(root => path.startsWith(root))) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (SERVER_FILE.test(name)) return false;
  return /\.(tsx|css)$/.test(name) || /\.test\.tsx?$/.test(name);
}

// Documentation only (docs_only): a file that is on the allow-list AND is plainly a document. Narrower than the allow-list on purpose:
//   - under docs/ or at the repository root (README.md, AGENTS.md ...), never a markdown file elsewhere (apps/web/content, fixtures);
//   - with a documentation extension. docs/ also holds .mjs, .sql, .graphql and .json files: those can be run or read by tooling,
//     so a change to one of them is not documentation only.
const DOCUMENT_EXTENSION = /\.(md|txt|csv|png|jpe?g|gif|svg|html)$/i;
export function isDocsPath(path) {
  if (!isSkippablePath(path) || !DOCUMENT_EXTENSION.test(path)) return false;
  return path.startsWith('docs/') || !path.includes('/');
}

// { full, docsOnly, reason }. Unknown, missing or empty input always means the full suite, and never docs only.
export function decide({ eventName, baseRef, files }) {
  const full = reason => ({ full: true, docsOnly: false, reason });
  if (eventName !== 'pull_request') return full(`event is ${eventName || 'unknown'}, not a pull request`);
  if (baseRef !== 'staging') return full(`pull request base is ${baseRef || 'unknown'}, not staging`);
  if (!Array.isArray(files)) return full('the changed-file list is unavailable');
  if (files.length === 0) return full('the changed-file list is empty');
  const blocking = files.find(file => !isSkippablePath(file));
  if (blocking !== undefined) return full(`${JSON.stringify(blocking)} is not on the allow-list`);
  return { full: false, docsOnly: files.every(isDocsPath), reason: `all ${files.length} changed files are on the allow-list` };
}

// Files the pull request changes: the checked-out merge commit against its first parent (the base branch tip).
// Returns null when that cannot be established.
export function changedFiles(git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) {
  try {
    if (git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length !== 3) return null;
    return git('diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const baseRef = process.env.GITHUB_BASE_REF;
  const { full, docsOnly, reason } = decide({ eventName, baseRef, files: eventName === 'pull_request' ? changedFiles() : null });
  console.log(`full=${full} docs_only=${docsOnly}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\ndocs_only=${docsOnly}\n`);
}
