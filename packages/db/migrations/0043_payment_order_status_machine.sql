/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: payment order status machine
-- Description:
--   Expands Graylum payment order states so checkout, payment failure,
--   cancellation, expiration, and refund states can be represented without
--   treating paid-but-unfulfilled orders as completed.
--   Do not apply to staging or production without explicit owner approval.

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_status_check;

UPDATE public.payment_orders
SET status = 'canceled'
WHERE status = 'cancelled';

UPDATE public.payment_orders
SET status = 'partially_refunded'
WHERE status = 'partial_refunded';

ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (
    status IN (
      'pending',
      'completed',
      'failed',
      'canceled',
      'expired',
      'refunded',
      'partially_refunded',
      -- Legacy compatibility until older refund/cancel writers are retired.
      'cancelled',
      'partial_refunded'
    )
  );

COMMENT ON CONSTRAINT payment_orders_status_check ON public.payment_orders
IS 'Graylum payment order state machine. Canonical statuses: pending, completed, failed, canceled, expired, refunded, partially_refunded. Legacy cancelled/partial_refunded accepted for compatibility.';
