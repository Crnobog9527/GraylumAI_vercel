/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The structure half of the Waffo delivery suite: builds the database from repository files with the apply-twice and
// structure-fingerprint check on every migration before 0221 (the part of the build the behaviour cases build on), then stops.
// The behaviour cases, and the same check for 0221 onward over Waffo data, are in run-local.mjs. See the note there.
// Takes the same --ci / --local-only flag as run-local.mjs, which checks it.
process.argv.push('--structure-only');
await import('./run-local.mjs');
