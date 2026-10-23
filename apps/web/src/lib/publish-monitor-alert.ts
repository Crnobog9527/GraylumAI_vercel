/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';

// PUBLISH-MONITOR plan §9 item 25: Post for Me cleanup stopped after 50 attempts and needs a person ("外部待处理" on
// /admin/publish-monitor/cleanup). Raised on every run while any remain, so Sentry keeps one issue for the fixed code.
// Sentry's scrubber lets only a registered code prefix (PUBLISH_MONITOR) through, so what reaches Sentry is the fixed
// message; the counts stay here for local logs and are also in the run record (scheduled_job_runs.summary.stuck).
// No connection, request or provider account ids leave the cron.
export function reportPublishMonitorStuck(stuck: { connections: number; requests: number } | null) {
  if (!stuck || stuck.connections + stuck.requests === 0) return;
  const code = 'PUBLISH_MONITOR_CLEANUP_STUCK';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'publish_monitor', code },
    extra: { connections: stuck.connections, requests: stuck.requests, page: '/admin/publish-monitor/cleanup' },
  });
}
