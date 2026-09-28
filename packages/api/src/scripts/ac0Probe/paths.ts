/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {existsSync, realpathSync} from 'node:fs';
import {userInfo} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

/** The only home directory the probe uses: the ledger, its lock, manual entries
 * and the default results directory all live under it. It comes from the
 * system account database, so changing HOME cannot select a fresh ledger. */
export function accountHome(): string {
  return userInfo().homedir;
}

/** Canonical path: the deepest existing ancestor is resolved through every
 * symlink, the part that does not exist yet is appended unchanged. */
export function realPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Private Skill text and results never live in a repository, even through a symlink. */
export function assertOutsideRepository(path: string, what = 'output'): void {
  let current = realPath(path);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      throw new Error(`PROBE_${what.toUpperCase()}_INSIDE_REPOSITORY: choose a ${what} path outside any git checkout`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
