/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// next.config reads these switches at build time. `pnpm build` runs `turbo build`, whose strict environment mode
// hides every variable that is not allowlisted, so an unlisted switch would silently stay off.
test('turbo passes the build-time site switches to next build', () => {
  const turbo = JSON.parse(readFileSync(new URL('../../turbo.json', import.meta.url), 'utf8'));
  for (const name of ['SINGLE_HOST_REDIRECTS', 'SITE_INDEXING']) {
    assert.ok(turbo.globalEnv.includes(name), name);
  }
});
