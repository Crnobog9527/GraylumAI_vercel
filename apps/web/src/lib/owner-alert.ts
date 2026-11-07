/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { after } from 'next/server';
import { notifyOwner, type OwnerAlertFacts, type OwnerAlertKind } from '@repo/api/src/services/ownerAlerts';

/**
 * ALERT-FEISHU: send the Owner's Feishu alert after the response (Next after(), which Vercel keeps alive with waitUntil),
 * so a webhook or cron answers without waiting for Feishu. Outside a request scope (a test, a script) it is sent at once.
 * notifyOwner never throws and skips silently when the Feishu variables are not set.
 */
export function alertOwnerAfterResponse<K extends OwnerAlertKind>(kind: K, facts: OwnerAlertFacts[K]): void {
  try {
    after(() => notifyOwner(kind, facts));
  } catch {
    void notifyOwner(kind, facts);
  }
}
