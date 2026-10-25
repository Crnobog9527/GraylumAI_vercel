/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import { setLogSink, type LogSink } from '@repo/api/src/lib/logger';

/** `API_<CATEGORY>_<MESSAGE>`: a fixed code built from the logger's category and its fixed snake_case message, so Sentry
 * keeps one issue per place. It is the only thing that leaves: the scrubber (sentry-scrub.ts) passes a message only when it
 * is a code of a registered prefix, and the log context (ids, amounts) is never handed to the sink. */
export function apiLogCode(entry: Parameters<LogSink>[0]): string {
  const tail = `${entry.category}_${entry.message}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `API_${tail.slice(0, 60) || 'UNKNOWN'}`;
}

/** The api package has no Sentry dependency of its own: its error logs and swallowed failures (lib/swallow.ts) are forwarded
 * here, through the Sentry instance this server initialised in instrumentation.ts. */
export function connectApiLogsToSentry() {
  setLogSink(entry => {
    captureMessage(apiLogCode(entry), { level: entry.level === 'error' ? 'error' : 'warning' });
  });
}
