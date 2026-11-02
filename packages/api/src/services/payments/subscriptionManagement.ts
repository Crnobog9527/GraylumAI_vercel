/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../../lib/logger';

/**
 * Whether the "manage subscription" button shows. Only a hint: a read or Stripe failure (two renewing card subscriptions, an
 * unreachable Stripe) must not fail the profile page with a 500 (round 10, user7); it answers "not available" and logs its cause.
 */
export async function subscriptionManagementAvailable(find: () => Promise<boolean>): Promise<{ available: boolean }> {
  try {
    return { available: await find() };
  } catch (error) {
    logger.error('billing', 'payments_subscription_management_probe_failed', {
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return { available: false };
  }
}
