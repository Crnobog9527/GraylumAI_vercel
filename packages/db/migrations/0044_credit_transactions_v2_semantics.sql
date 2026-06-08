/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: credit_transactions v2 semantics
-- Description:
--   Adds explicit ledger semantics so AI spend, grants, refund clawbacks,
--   adjustments, and expirations are not inferred only from amount sign.
--   Do not apply to staging or production without explicit owner approval.

ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS ledger_type TEXT,
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS counts_as_spend BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS source_order_id UUID,
  ADD COLUMN IF NOT EXISTS source_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS grant_period_key TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.normalize_credit_transaction_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type TEXT := COALESCE(NEW.type, '');
  v_description TEXT := COALESCE(NEW.description, '');
  v_idempotency_key TEXT := COALESCE(NEW.idempotency_key, '');
BEGIN
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb);

  IF NEW.ledger_type IS NULL OR btrim(NEW.ledger_type) = '' THEN
    NEW.ledger_type := CASE
      WHEN COALESCE(NEW.amount, 0) < 0
        AND (
          NEW.source_type = 'stripe_refund'
          OR v_idempotency_key LIKE 'stripe_refund:%'
          OR v_description ILIKE '%refund credit clawback%'
          OR v_description ILIKE '%stripe refund%'
          OR v_description ILIKE '%退款扣回%'
          OR v_description ILIKE '%订单退款扣除积分%'
        )
        THEN 'refund_clawback'
      WHEN v_type = 'expiration'
        THEN 'expiration'
      WHEN COALESCE(NEW.amount, 0) < 0
        AND v_type IN ('deduction', 'consumption', 'usage')
        AND (
          NEW.source_type = 'admin'
          OR v_idempotency_key LIKE 'admin_adjustment:%'
          OR v_idempotency_key LIKE 'admin_credit_deduction:%'
          OR v_description ILIKE '%管理员%'
          OR v_description ILIKE '%admin%'
          OR v_description ILIKE '%调整%'
          OR v_description ILIKE '%adjustment%'
        )
        THEN 'adjustment'
      WHEN COALESCE(NEW.amount, 0) < 0
        AND v_type IN ('deduction', 'consumption', 'usage')
        AND (
          NEW.source_type = 'ai_task'
          OR v_idempotency_key LIKE 'ai_spend:%'
          OR v_description ILIKE '%AI 对话消费%'
          OR v_description ILIKE '%AI 对话结算%'
          OR v_description ILIKE '%AI 对话中断结算%'
          OR v_description ILIKE '%ai task%'
          OR v_description ILIKE '%ai spend%'
        )
        THEN 'spend'
      WHEN COALESCE(NEW.amount, 0) < 0
        AND v_type IN ('deduction', 'consumption', 'usage')
        THEN 'adjustment'
      WHEN COALESCE(NEW.amount, 0) > 0
        AND v_type IN ('addition', 'purchase', 'bonus', 'checkin', 'membership')
        THEN 'grant'
      ELSE 'adjustment'
    END;
  END IF;

  IF NEW.reason_code IS NULL OR btrim(NEW.reason_code) = '' THEN
    NEW.reason_code := CASE
      WHEN NEW.ledger_type = 'refund_clawback'
        THEN 'refund_clawback'
      WHEN NEW.ledger_type = 'spend'
        THEN 'ai_task_spend'
      WHEN NEW.ledger_type = 'expiration'
        THEN 'expiration'
      WHEN NEW.ledger_type = 'grant' AND v_type = 'purchase'
        THEN 'topup_purchase'
      WHEN NEW.ledger_type = 'grant'
        AND (v_type = 'checkin' OR v_description ILIKE '%签到%' OR v_description ILIKE '%checkin%')
        THEN 'checkin'
      WHEN NEW.ledger_type = 'grant'
        AND (v_description ILIKE '%会员%' OR v_description ILIKE '%invoice%' OR v_description ILIKE '%subscription%')
        THEN 'subscription_grant'
      WHEN NEW.ledger_type = 'grant'
        THEN 'bonus_grant'
      WHEN v_type = 'refund'
        THEN 'credit_refund'
      ELSE 'admin_adjustment'
    END;
  END IF;

  NEW.counts_as_spend := NEW.ledger_type = 'spend';

  IF NEW.source_type IS NULL OR btrim(NEW.source_type) = '' THEN
    NEW.source_type := CASE
      WHEN NEW.ledger_type = 'refund_clawback'
        THEN 'stripe_refund'
      WHEN NEW.ledger_type = 'spend'
        THEN 'ai_task'
      WHEN NEW.ledger_type = 'grant'
        AND (v_description ILIKE '%invoice%' OR v_description ILIKE '%会员%')
        THEN 'stripe_invoice'
      WHEN NEW.ledger_type = 'grant'
        AND (v_type = 'purchase' OR v_description ILIKE '%checkout%')
        THEN 'stripe_checkout'
      WHEN NEW.ledger_type IN ('grant', 'expiration')
        THEN 'system'
      ELSE 'admin'
    END;
  END IF;

  IF NEW.source_refund_id IS NULL
    AND NEW.ledger_type = 'refund_clawback'
    AND v_idempotency_key LIKE 'stripe_refund:%'
  THEN
    NEW.source_refund_id := NULLIF(split_part(v_idempotency_key, ':', 2), '');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_credit_transaction_v2 ON public.credit_transactions;
CREATE TRIGGER trg_normalize_credit_transaction_v2
BEFORE INSERT OR UPDATE ON public.credit_transactions
FOR EACH ROW
EXECUTE FUNCTION public.normalize_credit_transaction_v2();

UPDATE public.credit_transactions
SET ledger_type = ledger_type
WHERE ledger_type IS NULL
  OR reason_code IS NULL
  OR source_type IS NULL
  OR metadata IS NULL
  OR counts_as_spend IS DISTINCT FROM (ledger_type = 'spend');

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_ledger_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_ledger_type_check
  CHECK (
    ledger_type IS NULL
    OR ledger_type IN ('grant', 'spend', 'refund_clawback', 'adjustment', 'expiration')
  );

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_source_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_source_type_check
  CHECK (
    source_type IS NULL
    OR source_type IN ('stripe_invoice', 'stripe_checkout', 'stripe_refund', 'ai_task', 'admin', 'system')
  );

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_ledger_created
  ON public.credit_transactions(user_id, ledger_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_spend_created
  ON public.credit_transactions(user_id, created_at DESC)
  WHERE counts_as_spend = TRUE;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_source
  ON public.credit_transactions(source_type, source_id);

COMMENT ON COLUMN public.credit_transactions.ledger_type
  IS 'Billing Engine v1.5 ledger category: grant, spend, refund_clawback, adjustment, expiration.';

COMMENT ON COLUMN public.credit_transactions.reason_code
  IS 'Machine-readable reason for the ledger entry, such as ai_task_spend, topup_purchase, subscription_grant, refund_clawback, or admin_adjustment.';

COMMENT ON COLUMN public.credit_transactions.counts_as_spend
  IS 'True only for AI usage spend that should count toward monthly consumption.';

COMMENT ON COLUMN public.credit_transactions.source_type
  IS 'Origin system for the ledger entry: stripe_invoice, stripe_checkout, stripe_refund, ai_task, admin, or system.';

COMMENT ON COLUMN public.credit_transactions.source_order_id
  IS 'Optional payment_orders id when the ledger entry is tied to a Graylum order.';

COMMENT ON COLUMN public.credit_transactions.source_refund_id
  IS 'Optional Stripe refund id for refund clawback entries.';

COMMENT ON COLUMN public.credit_transactions.grant_period_key
  IS 'Optional YYYY-MM or subscription period key for future subscription_credit_grants integration.';

COMMENT ON COLUMN public.credit_transactions.metadata
  IS 'Structured audit metadata for credit ledger v2 entries.';
