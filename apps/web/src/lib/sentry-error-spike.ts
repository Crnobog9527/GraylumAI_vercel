/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ErrorEvent } from '@sentry/nextjs';
import { noteServerError } from '@repo/api/src/services/ownerAlerts/errorSpike';

/**
 * ALERT-FEISHU: called by the server's Sentry beforeSend with the scrubbed event. Every error or fatal event that will be sent
 * is counted; many in a short time tell the Owner in Feishu (what the Sentry error mail covered). Warnings, dropped events and
 * events without a level other than error are passed through untouched. noteServerError never throws, so the event is never lost.
 */
export function countServerError(event: ErrorEvent | null): ErrorEvent | null | Promise<ErrorEvent | null> {
  if (!event || (event.level && event.level !== 'error' && event.level !== 'fatal')) return event;
  return noteServerError().then(() => event);
}
