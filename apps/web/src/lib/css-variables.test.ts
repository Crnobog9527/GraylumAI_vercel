import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * UI-UNIFY A0: `var(--color-error)` and `var(--border-default)` were read in 24 places and defined nowhere, so error text had no color
 * and borders were black (publish monitor, connect, expert consult). Any CSS variable read without a fallback must be defined somewhere in
 * the app's styles or scripts. The few names below are set by a library or by an inline style at render time, or are a known gap kept out
 * of this change (the admin pages are not part of the UI A0 scope).
 */
const SOURCE = resolve(import.meta.dirname, '..');
const SET_AT_RUNTIME = /^--(radix-|bd-|d-display$|h$|x$)/;
const KNOWN_GAPS = new Set(['--color-primary-hover']);

/** The matches of one pattern over the app's styles and scripts (tests left out), as "file:match" lines; native grep keeps it fast. */
const grep = (pattern: string, names: boolean) => execFileSync('grep', ['-rEo', ...(names ? ['-h'] : []), '--include=*.css', '--include=*.ts', '--include=*.tsx',
  '--exclude=*.test.ts', '--exclude=*.test.tsx', '-e', pattern, SOURCE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

describe('CSS variables', () => {
  it('every variable read without a fallback is defined', () => {
    const defined = new Set<string>();
    for (const line of grep(`--[A-Za-z0-9_-]+[[:space:]]*:`, true)) defined.add(line.replace(/\s*:$/, ''));
    for (const line of grep(`['"]--[A-Za-z0-9_-]+['"][[:space:]]*:`, true)) defined.add(line.replace(/^['"]|['"]\s*:$/g, ''));
    for (const line of grep(String.raw`\[--[A-Za-z0-9_-]+`, true)) defined.add(line.slice(1));
    const missing = new Map<string, string>();
    for (const line of grep(String.raw`var\([[:space:]]*--[A-Za-z0-9_-]+[[:space:]]*\)`, false)) {
      const [file, match] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
      const name = /--[A-Za-z0-9_-]+/.exec(match)![0];
      if (!defined.has(name) && !SET_AT_RUNTIME.test(name) && !KNOWN_GAPS.has(name)) missing.set(name, file.slice(SOURCE.length + 1));
    }
    expect([...missing].map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });

  it('the light scopes define the state and shadcn variables the ui/ components read', () => {
    const needed = ['--background', '--foreground', '--muted', '--border', '--input', '--ring', '--accent', '--secondary', '--destructive',
      '--success', '--warning', '--error', '--info', '--info-bg', '--text-disabled', '--color-primary-10', '--color-primary-20', '--color-primary-30',
      '--color-error', '--border-default'];
    for (const file of ['components/opc/workspace-frame.module.css', 'components/design/light-tokens.module.css']) {
      const text = readFileSync(join(SOURCE, file), 'utf8');
      expect(needed.filter(name => !new RegExp(`${name}\\s*:`).test(text)), file).toEqual([]);
    }
    const globals = readFileSync(join(SOURCE, 'app/globals.css'), 'utf8');
    const lightBody = globals.slice(globals.indexOf("html[data-first-paint='light'] body"), globals.indexOf("html[data-first-paint='light'] .skeleton"));
    expect(needed.filter(name => !new RegExp(`${name}\\s*:`).test(lightBody)), 'globals.css light body').toEqual([]);
    expect(lightBody).toContain('color: #262626');
  });
});
