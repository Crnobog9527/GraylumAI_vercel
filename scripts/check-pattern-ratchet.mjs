#!/usr/bin/env node

// Ratchet for code patterns that each change could add one more of (docs/ENGINEERING.md): swallowed errors, direct
// settings and environment reads, error codes matched by string, double casts in payments. Each pattern in
// scripts/pattern-ratchet.json has a frozen maximum; the count may only go down. Same idea as check-code-size.mjs.

import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSourceFiles } from './check-code-size.mjs';

export const RATCHET_PATH = 'scripts/pattern-ratchet.json';
const KEYS = new Set(['id', 'description', 'include', 'exclude', 'regex', 'count', 'max']);

export function parseRatchet(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.patterns)) throw new Error('pattern ratchet must be {"patterns": [...]}');
  const ids = new Set();
  for (const entry of parsed.patterns) {
    const id = entry?.id;
    const valid = typeof id === 'string' && /^[a-z0-9-]+$/.test(id) && !ids.has(id)
      && Object.keys(entry).every(key => KEYS.has(key))
      && typeof entry.description === 'string' && entry.description.length > 0
      && Array.isArray(entry.include) && entry.include.length > 0 && entry.include.every(item => typeof item === 'string' && item)
      && (entry.exclude === undefined || (Array.isArray(entry.exclude) && entry.exclude.every(item => typeof item === 'string' && item)))
      && typeof entry.regex === 'string' && ['matches', 'files'].includes(entry.count)
      && Number.isSafeInteger(entry.max) && entry.max >= 0;
    if (!valid) throw new Error(`invalid pattern ratchet entry ${JSON.stringify(id)}`);
    new RegExp(entry.regex, 'g');
    ids.add(id);
  }
  return parsed;
}

/** Files in scope: path starts with one of `include` and with none of `exclude`. */
const inScope = (entry, file) => entry.include.some(prefix => file.startsWith(prefix))
  && !(entry.exclude ?? []).some(prefix => file.startsWith(prefix));

/** `sources`: Map of file → text. Returns the count per pattern id. */
export function countPatterns(ratchet, sources) {
  const counts = new Map();
  for (const entry of ratchet.patterns) {
    const regex = new RegExp(entry.regex, 'g');
    let total = 0;
    for (const [file, text] of sources) {
      if (!inScope(entry, file)) continue;
      const found = text.match(regex)?.length ?? 0;
      total += entry.count === 'files' ? Math.min(found, 1) : found;
    }
    counts.set(entry.id, total);
  }
  return counts;
}

/** `errors`: a pattern above its maximum. `stale`: a maximum higher than needed, which must be lowered to keep the gain. */
export function checkRatchet(ratchet, counts) {
  const errors = [];
  const stale = [];
  for (const entry of ratchet.patterns) {
    const value = counts.get(entry.id) ?? 0;
    if (value > entry.max) {
      errors.push(`${entry.id}: ${value} ${entry.count}, allowed ${entry.max}. ${entry.description}`);
    } else if (value < entry.max) {
      stale.push(`${entry.id}: maximum ${entry.max} can be lowered to ${value}.`);
    }
  }
  return { errors, stale };
}

/** `--update` only lowers maximums. Raising one is a reviewed manual edit of the JSON. */
export function tightenRatchet(ratchet, counts) {
  return { ...ratchet, patterns: ratchet.patterns.map(entry => ({ ...entry, max: Math.min(entry.max, counts.get(entry.id) ?? 0) })) };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(repositoryRoot, RATCHET_PATH);
  let ratchet = parseRatchet(await readFile(file, 'utf8'));
  const counts = countPatterns(ratchet, await collectSourceFiles(repositoryRoot));
  if (process.argv.includes('--update')) {
    ratchet = tightenRatchet(ratchet, counts);
    await writeFile(file, `${JSON.stringify(ratchet, null, 2)}\n`);
    console.log('Pattern ratchet tightened. Maximums are never raised by --update.');
  }
  const { errors, stale } = checkRatchet(ratchet, counts);
  for (const error of errors) console.error(`Pattern ratchet failed: ${error}`);
  for (const entry of stale) console.error(`Pattern ratchet is stale: ${entry}`);
  if (stale.length) console.error('Run `node scripts/check-pattern-ratchet.mjs --update` and commit the lowered maximums.');
  if (errors.length || stale.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`Pattern ratchet passed: ${ratchet.patterns.map(entry => `${entry.id}=${counts.get(entry.id)}`).join(', ')}.`);
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(path.resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isMainModule()) await main();
