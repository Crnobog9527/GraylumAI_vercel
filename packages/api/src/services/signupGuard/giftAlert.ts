/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { swallow } from '../../lib/swallow';
import { notifyOwner } from '../ownerAlerts';
import { OWNER_ALERT_TURN_BUDGET_MS } from '../ownerAlerts/notify';

/**
 * BOT-GUARD part 3 (controller 2026-11-13): tell the Owner when the day's opening grants pass half, and 90%, of the daily
 * cap, once per Beijing day and level (the alert's dedupe key). The count comes from opening_grant_claim's answer
 * (`gift`, read inside the grant's lock), so no extra database read. Never throws and never changes the sign-in.
 */
const giftSchema = z.object({ day: z.string(), granted: z.number().int().min(0), cap: z.number().int().min(0) });

export function giftLevel(granted: number, cap: number): 'half' | 'near_full' | null {
  if (cap <= 0) return null;
  if (granted >= Math.ceil(cap * 0.9)) return 'near_full';
  if (granted >= Math.ceil(cap / 2)) return 'half';
  return null;
}

export async function noteOpeningGrant(answer: unknown, notify: typeof notifyOwner = notifyOwner): Promise<void> {
  const gift = giftSchema.safeParse((answer as { gift?: unknown } | null)?.gift);
  if (!gift.success) return;
  const level = giftLevel(gift.data.granted, gift.data.cap);
  if (!level) return;
  await swallow('signup_gift_alert_failed', notify('signup_gift_level', { ...gift.data, level }, { budgetMs: OWNER_ALERT_TURN_BUDGET_MS }),
    undefined, { category: 'system' });
}
