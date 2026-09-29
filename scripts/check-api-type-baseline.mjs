#!/usr/bin/env node

// Ratchet check for the standalone API type check (docs/ENGINEERING.md).
// packages/api/tsconfig.json excludes test files that already had type errors
// when the check was added. That list must equal packages/api/type-check-baseline.json
// and may only shrink: a baselined file that now compiles must be removed from both.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_DIRECTORY = 'packages/api';
export const BASELINE_FILE = 'type-check-baseline.json';
const ALWAYS_EXCLUDED = new Set(['node_modules']);

/**
 * `exclude` is the tsconfig list, `baseline` the committed list, and
 * `errorCounts` maps project-relative files to type errors from one full run
 * with nothing but node_modules excluded.
 */
export function checkTypeBaseline({ exclude, baseline, errorCounts }) {
  const errors = [];
  const excluded = new Set(exclude.filter((entry) => !ALWAYS_EXCLUDED.has(entry)));
  const allowed = new Set(baseline);
  if (allowed.size !== baseline.length) errors.push(`${BASELINE_FILE} lists a file more than once.`);
  for (const entry of excluded) {
    if (!allowed.has(entry)) {
      errors.push(`tsconfig.json excludes ${entry}, which is not in ${BASELINE_FILE}. Fix its type errors instead of excluding it.`);
    }
  }
  for (const entry of allowed) {
    if (!excluded.has(entry)) {
      errors.push(`${BASELINE_FILE} lists ${entry}, which tsconfig.json no longer excludes. Remove it from ${BASELINE_FILE}.`);
    } else if (!errorCounts.get(entry)) {
      errors.push(`${entry} now has no type errors. Remove it from tsconfig.json "exclude" and ${BASELINE_FILE}.`);
    }
  }
  for (const [file, count] of errorCounts) {
    if (count > 0 && !allowed.has(file)) errors.push(`${file}: ${count} type errors outside the baseline.`);
  }
  return errors;
}

/** One type-check run over the project with the baseline exclusions lifted. */
export function countTypeErrors(projectDirectory, ts) {
  const configPath = path.join(projectDirectory, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const raw = { ...read.config, exclude: [...ALWAYS_EXCLUDED] };
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, projectDirectory, undefined, configPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const counts = new Map();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const file = diagnostic.file ? path.relative(projectDirectory, diagnostic.file.fileName).split(path.sep).join('/') : '<global>';
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return { exclude: read.config.exclude ?? [], counts };
}

export function runCheck(projectDirectory) {
  const ts = createRequire(path.join(projectDirectory, 'package.json'))('typescript');
  const baseline = JSON.parse(readFileSync(path.join(projectDirectory, BASELINE_FILE), 'utf8'));
  const { exclude, counts } = countTypeErrors(projectDirectory, ts);
  return { errors: checkTypeBaseline({ exclude, baseline, errorCounts: counts }), baseline };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { errors, baseline } = runCheck(path.join(root, API_DIRECTORY));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`API type-check baseline matches: ${baseline.length} excluded test files, all still failing.`);
  }
}
