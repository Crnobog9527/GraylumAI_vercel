/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

let workspaceEnvLoaded = false;

export function ensureWorkspaceServerEnv() {
  if (workspaceEnvLoaded) {
    return;
  }

  workspaceEnvLoaded = true;

  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const rootEnvPath = path.resolve(baseDir, '../../../../.env.local');
  const webEnvPath = path.resolve(baseDir, '../../../../apps/web/.env.local');

  if (existsSync(rootEnvPath)) {
    loadDotenv({ path: rootEnvPath, override: false });
  }

  if (existsSync(webEnvPath)) {
    // App-local values should override repo-root defaults when both exist.
    loadDotenv({ path: webEnvPath, override: true });
  }
}
