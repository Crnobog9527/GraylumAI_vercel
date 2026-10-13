/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Entry so `node scripts/staging-login <role>` works; the implementation is ESM in cli.mjs.
'use strict';

import('./cli.mjs').then(module => module.main());
