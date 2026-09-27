#!/usr/bin/env node

// Ratchet check for source file size and line width (docs/ENGINEERING.md).
// New code must stay within the limits. Files that already exceed them are
// frozen in scripts/code-size-baseline.json and may only shrink.

import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MAX_LINES = 500;
export const MAX_LINE_LENGTH = 160;
export const BASELINE_PATH = 'scripts/code-size-baseline.json';

const SOURCE_FILE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests|e2e)\/|\.(?:test|spec|integration)\.[^/]+$/;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/** Test files, fixtures and non-source files are outside the ratchet. */
export function isCheckedFile(file) {
  return SOURCE_FILE.test(file) && !TEST_FILE.test(file);
}

/** Lines are counted without a trailing newline; width is in Unicode code points. */
export function measure(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let longLines = 0;
  for (const line of lines) {
    if ([...line.replace(/\r$/, '')].length > MAX_LINE_LENGTH) longLines += 1;
  }
  return { lines: lines.length, longLines };
}

function describeEntry(entry) {
  return Object.entries(entry).map(([key, value]) => `${key}=${value}`).join(', ');
}

/**
 * Compare measurements with the baseline. `errors` are growth beyond the
 * allowance; `stale` entries are higher than needed and must be lowered so the
 * ratchet keeps every improvement.
 */
export function checkCodeSize(measurements, baseline) {
  const errors = [];
  const stale = [];
  for (const [file, value] of measurements) {
    const entry = baseline[file] ?? {};
    const allowedLines = Math.max(MAX_LINES, entry.lines ?? 0);
    const allowedLongLines = entry.longLines ?? 0;
    if (value.lines > allowedLines) {
      errors.push(`${file}: ${value.lines} lines, allowed ${allowedLines}. Split the file instead of growing it.`);
    }
    if (value.longLines > allowedLongLines) {
      errors.push(
        `${file}: ${value.longLines} lines longer than ${MAX_LINE_LENGTH} characters, allowed ${allowedLongLines}. Wrap the new long lines.`,
      );
    }
  }
  for (const [file, entry] of Object.entries(baseline)) {
    const value = measurements.get(file);
    const needed = value ? tightenEntry(entry, value) : undefined;
    const current = describeEntry(entry);
    if (!needed) stale.push(`${file}: baseline ${current} is no longer needed.`);
    else if (describeEntry(needed) !== current) stale.push(`${file}: baseline ${current} can be lowered to ${describeEntry(needed)}.`);
  }
  return { errors, stale };
}

/** The tightest entry that still covers the measured file; never higher than before. */
function tightenEntry(entry, value) {
  const next = {};
  if (entry.lines !== undefined && value.lines > MAX_LINES) next.lines = Math.min(entry.lines, value.lines);
  if (entry.longLines !== undefined && value.longLines > 0) next.longLines = Math.min(entry.longLines, value.longLines);
  return Object.keys(next).length ? next : undefined;
}

/** `--update` only lowers or removes entries. Raising one is a reviewed manual edit. */
export function tightenBaseline(measurements, baseline) {
  const next = {};
  for (const [file, entry] of Object.entries(baseline)) {
    const value = measurements.get(file);
    const tightened = value ? tightenEntry(entry, value) : undefined;
    if (tightened) next[file] = tightened;
  }
  return next;
}

export function formatBaseline(baseline) {
  const entries = Object.keys(baseline)
    .sort()
    .map(file => `  ${JSON.stringify(file)}: ${JSON.stringify(baseline[file])}`);
  return entries.length ? `{\n${entries.join(',\n')}\n}\n` : '{}\n';
}

export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('baseline must be a JSON object');
  for (const [file, entry] of Object.entries(parsed)) {
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
    const valid = keys.length > 0 && keys.every(key => ['lines', 'longLines'].includes(key) && Number.isSafeInteger(entry[key]) && entry[key] > 0);
    if (!valid) throw new Error(`invalid baseline entry for ${file}`);
  }
  return parsed;
}

/** Tracked regular files as they are in the working tree. */
export async function collectMeasurements(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '--stage', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const measurements = new Map();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const [meta, file] = record.split('\t');
    if (!REGULAR_FILE_MODES.has(meta.split(' ')[0]) || !isCheckedFile(file)) continue;
    let text;
    try {
      text = await readFile(path.join(repositoryRoot, file), 'utf8');
    } catch (error) {
      // A tracked file deleted in the working tree is not part of this change.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    measurements.set(file, measure(text));
  }
  return measurements;
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const update = process.argv.includes('--update');
  const baselineFile = path.join(repositoryRoot, BASELINE_PATH);
  const baseline = parseBaseline(await readFile(baselineFile, 'utf8'));
  const measurements = await collectMeasurements(repositoryRoot);

  let effective = baseline;
  if (update) {
    effective = tightenBaseline(measurements, baseline);
    await writeFile(baselineFile, formatBaseline(effective));
    const removed = Object.keys(baseline).length - Object.keys(effective).length;
    console.log(`Code size baseline tightened (${removed} entries removed). Entries are never raised by --update.`);
  }

  const { errors, stale } = checkCodeSize(measurements, effective);
  for (const error of errors) console.error(`Code size check failed: ${error}`);
  for (const entry of stale) console.error(`Code size baseline is stale: ${entry}`);
  if (stale.length) console.error('Run `node scripts/check-code-size.mjs --update` and commit the lowered baseline.');
  if (errors.length) console.error('See docs/ENGINEERING.md, "代码大小与格式", for how to split files and when a baseline may be raised.');
  if (errors.length || stale.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`Code size check passed for ${measurements.size} source files.`);
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
