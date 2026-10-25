/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * DB-100 C5 guard: every server-side client built with the service-role key either goes through withViewVersionBump
 * (so its writes replace the conversation view version tokens) or is on this list because it can never change what a
 * conversation page shows (tickets, analytics, social monitoring, auth-only reads).
 */
const NEVER_TOUCHES_CONVERSATIONS = [
  'apps/web/src/app/api/cron/diagnostics/route.ts',
  'apps/web/src/app/api/cron/social-monitor/route.ts',
  'apps/web/src/app/api/cron/ticket-attachments-cleanup/route.ts',
  'apps/web/src/app/api/cron/tickets/auto-close/route.ts',
  'apps/web/src/lib/entry-language-server.ts',
  'apps/web/src/lib/publish-monitor-connect.ts',
  'apps/web/src/proxy.ts',
];
it('every service-role database client bumps view versions or is listed as unrelated', () => {
  const root = join(__dirname, '../../../..');
  const files = execFileSync('git', ['-C', root, 'grep', '-l', 'SUPABASE_SERVICE_ROLE_KEY', '--', 'apps/web/src', 'packages/api/src'], { encoding: 'utf8' })
    .split('\n').filter(f => f && !/\.(test|integration)\.|\/scripts\/|envValidator/.test(f));
  const missing = files.filter(f => /createClient\(/.test(readFileSync(join(root, f), 'utf8'))
    && !readFileSync(join(root, f), 'utf8').includes('withViewVersionBump') && !NEVER_TOUCHES_CONVERSATIONS.includes(f));
  expect(missing).toEqual([]);
});
