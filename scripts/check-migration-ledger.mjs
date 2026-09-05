#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXACT_GIT_SHA = /^[0-9a-f]{40}$/i;
const LEGAL_MIGRATION_FILENAME = /^(?<number>\d{4})_(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;
const POST_BASELINE_START = 48;
const CHECKER_PATH = 'scripts/check-migration-ledger.mjs';
const HISTORICAL_0018_PAIR = new Set([
  '0018_payment_fulfillment_atomicity.sql',
  '0018_rls_text_flags_and_job_runs.sql',
]);

async function runGit(repositoryRoot, args, options = {}) {
  return execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function addMigration(migrationsByNumber, filename, number) {
  const files = migrationsByNumber.get(number) ?? [];
  files.push(filename);
  migrationsByNumber.set(number, files);
}

async function loadTrustedBase(repositoryRoot, relativeDirectory, baseSha) {
  const errors = [];
  if (!baseSha || !EXACT_GIT_SHA.test(baseSha)) {
    return { errors: ['Missing or invalid exact migration base SHA.'] };
  }

  try {
    await runGit(repositoryRoot, ['cat-file', '-e', `${baseSha}^{commit}`]);
  } catch {
    return { errors: [`Could not resolve exact migration base commit: ${baseSha}`] };
  }

  let hasTrustedChecker = false;
  try {
    const { stdout: checkerType } = await runGit(repositoryRoot, ['cat-file', '-t', `${baseSha}:${CHECKER_PATH}`]);
    if (checkerType.trim() !== 'blob') {
      errors.push(`Migration ledger checker in exact base is not a regular blob: ${CHECKER_PATH}`);
    } else {
      hasTrustedChecker = true;
    }
  } catch {
    // The current PR bootstraps the checker. Once present in a base, it is frozen too.
  }

  let stdout;
  try {
    ({ stdout } = await runGit(repositoryRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      baseSha,
      '--',
      relativeDirectory,
    ], { encoding: 'buffer' }));
  } catch {
    return { errors: [`Could not read migration evidence from exact base commit: ${baseSha}`] };
  }

  const prefix = `${relativeDirectory}/`;
  const treeEntries = stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const baseFiles = new Set();
  const baseMigrationsByNumber = new Map();

  for (const entry of treeEntries) {
    if (!entry.startsWith(prefix)) {
      errors.push(`Unexpected migration evidence path in exact base: ${entry}`);
      continue;
    }

    const filename = entry.slice(prefix.length);
    if (!filename.endsWith('.sql')) continue;
    if (filename.includes('/')) {
      errors.push(`Nested migration path in exact base is unsupported: ${filename}`);
      continue;
    }

    const match = LEGAL_MIGRATION_FILENAME.exec(filename);
    if (!match?.groups) {
      errors.push(`Malformed migration filename in exact base: ${filename}`);
      continue;
    }

    baseFiles.add(filename);
    addMigration(baseMigrationsByNumber, filename, match.groups.number);
  }

  if (baseFiles.size === 0) {
    errors.push(`Exact base commit contains no trusted migration evidence: ${baseSha}`);
  }

  const base0018 = baseMigrationsByNumber.get('0018') ?? [];
  const hasExactHistoricalPair = base0018.length === HISTORICAL_0018_PAIR.size
    && base0018.every((file) => HISTORICAL_0018_PAIR.has(file));
  if (!hasExactHistoricalPair) {
    errors.push('Exact base does not contain the required historical 0018 migration pair.');
  }

  return { baseFiles, baseMigrationsByNumber, errors, hasTrustedChecker };
}

async function exactBaseShaFromGitHubEvent() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) return undefined;

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (eventName === 'pull_request') return event.pull_request?.base?.sha;
  if (eventName === 'push') return event.before;
  throw new Error(`Unsupported GitHub event for migration ledger check: ${eventName}`);
}

export async function checkMigrationLedger(directory, { baseSha, repositoryRoot = process.cwd() } = {}) {
  const resolvedRoot = await realpath(path.resolve(repositoryRoot));
  const resolvedDirectory = await realpath(path.resolve(directory));
  const relativeDirectory = path.relative(resolvedRoot, resolvedDirectory).split(path.sep).join('/');
  if (!relativeDirectory || relativeDirectory.startsWith('../') || path.isAbsolute(relativeDirectory)) {
    return ['Migration directory must be inside the repository root.'];
  }

  const trustedBase = await loadTrustedBase(resolvedRoot, relativeDirectory, baseSha);
  if (!trustedBase.baseFiles || !trustedBase.baseMigrationsByNumber) return trustedBase.errors;

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const migrationsByNumber = new Map();
  const candidateFiles = new Set();
  const errors = [...trustedBase.errors];

  if (trustedBase.hasTrustedChecker) {
    let checkerDiff = '';
    try {
      ({ stdout: checkerDiff } = await runGit(resolvedRoot, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--name-status',
        baseSha,
        '--',
        CHECKER_PATH,
      ]));
    } catch {
      errors.push(`Could not compare the migration ledger checker with exact base: ${baseSha}`);
    }
    if (checkerDiff.trim()) {
      errors.push(`Migration ledger checker differs from exact base: ${CHECKER_PATH}`);
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      errors.push(`Nested migration directory is not allowed: ${entry.name}`);
      continue;
    }
    if (!entry.name.endsWith('.sql')) continue;
    if (!entry.isFile()) {
      errors.push(`Migration path must be a regular file: ${entry.name}`);
      continue;
    }

    const match = LEGAL_MIGRATION_FILENAME.exec(entry.name);
    if (!match?.groups) {
      errors.push(`Malformed migration filename: ${entry.name}`);
      continue;
    }

    candidateFiles.add(entry.name);
    addMigration(migrationsByNumber, entry.name, match.groups.number);
  }

  for (const baseFile of trustedBase.baseFiles) {
    if (!candidateFiles.has(baseFile)) errors.push(`Missing base-existing migration: ${baseFile}`);
  }

  let diffOutput = '';
  try {
    ({ stdout: diffOutput } = await runGit(resolvedRoot, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '--diff-filter=MDTUXB',
      baseSha,
      '--',
      relativeDirectory,
    ]));
  } catch {
    errors.push(`Could not compare migrations with exact base commit: ${baseSha}`);
  }

  for (const changedLine of diffOutput.trim().split('\n').filter(Boolean)) {
    const [, ...changedPaths] = changedLine.split('\t');
    errors.push(`Base-existing migration differs from exact base: ${changedPaths.join(' -> ')}`);
  }

  for (const [number, files] of migrationsByNumber) {
    if (files.length < 2) continue;

    const baseFiles = trustedBase.baseMigrationsByNumber.get(number) ?? [];
    const isExactHistoricalPair = number === '0018'
      && files.length === HISTORICAL_0018_PAIR.size
      && baseFiles.length === HISTORICAL_0018_PAIR.size
      && files.every((file) => HISTORICAL_0018_PAIR.has(file) && baseFiles.includes(file));
    if (!isExactHistoricalPair) {
      errors.push(`Duplicate migration number ${number}: ${files.sort().join(', ')}`);
    }
  }

  const baseNumbers = [...trustedBase.baseMigrationsByNumber.keys()].map(Number);
  const baseHighestNumber = Math.max(...baseNumbers);
  for (const candidateFile of candidateFiles) {
    if (trustedBase.baseFiles.has(candidateFile)) continue;
    const candidateNumber = Number(LEGAL_MIGRATION_FILENAME.exec(candidateFile).groups.number);
    if (candidateNumber <= baseHighestNumber) {
      errors.push(`New migration must follow exact base high-water mark ${String(baseHighestNumber).padStart(4, '0')}: ${candidateFile}`);
    }
  }

  const postBaselineNumbers = [...migrationsByNumber.keys()]
    .map(Number)
    .filter((number) => number >= POST_BASELINE_START)
    .sort((left, right) => left - right);
  const highestNumber = Math.max(postBaselineNumbers.at(-1) ?? 0, baseHighestNumber);
  for (let number = POST_BASELINE_START; number <= highestNumber; number += 1) {
    const paddedNumber = String(number).padStart(4, '0');
    if (!migrationsByNumber.has(paddedNumber)) {
      errors.push(`Missing post-baseline migration number ${paddedNumber}`);
    }
  }

  return errors;
}

async function main() {
  const directory = path.resolve(process.argv[2] ?? 'packages/db/migrations');
  let errors;
  try {
    errors = await checkMigrationLedger(directory, {
      baseSha: await exactBaseShaFromGitHubEvent(),
      repositoryRoot: process.cwd(),
    });
  } catch (error) {
    console.error(`Migration ledger check could not inspect the migration directory: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`Migration ledger check failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Migration ledger check passed.');
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const invokedPath = await realpath(path.resolve(process.argv[1]));
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (await isMainModule()) await main();
