#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * Guards the order of `backdrop-filter` and `-webkit-backdrop-filter` in the web app's stylesheets.
 *
 * Found on staging 2026-11-14 (UI-UNIFY, PUBLIC-SITE validation): when one rule declares both and the prefixed one comes
 * last, the production CSS minifier keeps only the last of the pair, so the shipped rule is `-webkit-backdrop-filter`
 * alone. Chrome does not read the prefixed property, and every glass surface (the home page header and first-screen window,
 * the public cards, the sign-in card) rendered with `backdrop-filter: none`. With the unprefixed declaration last, the
 * shipped rule is the standard one, which Chrome, Firefox and current Safari read.
 *
 * Rule: in any rule that declares both, the unprefixed `backdrop-filter` must come after `-webkit-backdrop-filter`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'apps/web/src');

/** Every rule body in `css` whose last unprefixed backdrop-filter comes before its last prefixed one, with its line. */
export function misorderedRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
  const found = [];
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const declarations = match[1].split(';').map(part => part.trim().split(':')[0]?.trim().toLowerCase());
    const plain = declarations.lastIndexOf('backdrop-filter');
    const prefixed = declarations.lastIndexOf('-webkit-backdrop-filter');
    if (plain >= 0 && prefixed >= 0 && plain < prefixed) {
      found.push(text.slice(0, match.index).split('\n').length);
    }
  }
  return found;
}

function selfTest() {
  const cases = [
    ['.a { backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }', 1],
    ['.a{backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}', 1],
    ['.a { -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }', 0],
    ['.a { backdrop-filter: blur(4px); }', 0],
    ['/* backdrop-filter: x; -webkit-backdrop-filter: y; */ .a { color: red; }', 0],
    ['@media (min-width: 1px) { .a { backdrop-filter: none; -webkit-backdrop-filter: none } }', 1],
  ];
  for (const [css, expected] of cases) {
    const got = misorderedRules(css).length;
    if (got !== expected) throw new Error(`self-test failed for ${JSON.stringify(css)}: expected ${expected}, got ${got}`);
  }
}

function cssFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  selfTest();
  const problems = cssFiles(SOURCE).flatMap(file =>
    misorderedRules(readFileSync(file, 'utf8')).map(line => `${relative(ROOT, file)}:${line}`));
  if (problems.length) {
    console.error('backdrop-filter order check failed: put the unprefixed backdrop-filter after -webkit-backdrop-filter in:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('The production CSS minifier keeps only the last of the pair; Chrome reads only the unprefixed one.');
    process.exit(1);
  }
  console.log(`backdrop-filter order check passed for ${cssFiles(SOURCE).length} stylesheets.`);
}
