-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE: SELECT only. Controller runs in a READ ONLY staging transaction.
-- First result: both counts MUST be 1; bypass-RLS/superuser is required to count all rows.
-- Second result: exactly 90 keys. CHECK counts FALSE rows (NULL passes); UNIQUE
-- counts duplicate non-NULL groups, not duplicate rows. Index violation_count is 0
-- because indexes add no separate row rule (their three UNIQUE constraints are above).
-- Columns include index predicates. Existing definitions/validity are also checked:
-- same-name drift or an invalid object is a blocker, never a pass based on existence.
-- Stop on any SQL error, omitted key, nonzero violation/missing/mismatch/invalid count.
-- Missing tables/CHECK/UNIQUE columns fail the query; never replace errors with zero.
-- Only object keys and counts leave the database; no row values are returned.

SELECT
  (pg_catalog.current_setting('transaction_read_only') = 'on')::integer AS read_only_count,
  (SELECT count(*) FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) AS full_visibility_count;

SELECT * FROM (
  SELECT 'con:ai_usage_logs.ai_usage_logs_status_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.ai_usage_logs')
        AND conname = 'ai_usage_logs_status_check') AS object_exists_count,
    (SELECT count(*) FROM public.ai_usage_logs
      WHERE (((status = ANY (ARRAY['success'::text, 'failed'::text, 'timeout'::text, 'rate_limited'::text, 'moderation_blocked'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['status']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.ai_usage_logs')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.ai_usage_logs')
        AND conname = 'ai_usage_logs_status_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''success''::text, ''failed''::text, ''timeout''::text, ''rate_limited''::text, ''moderation_blocked''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.ai_usage_logs')
        AND conname = 'ai_usage_logs_status_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:billing_history.billing_history_operation_type_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.billing_history')
        AND conname = 'billing_history_operation_type_check') AS object_exists_count,
    (SELECT count(*) FROM public.billing_history
      WHERE (((operation_type = ANY (ARRAY['pre_deduct'::text, 'settle'::text, 'refund'::text, 'abort_settle'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['operation_type']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.billing_history')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.billing_history')
        AND conname = 'billing_history_operation_type_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((operation_type = ANY (ARRAY[''pre_deduct''::text, ''settle''::text, ''refund''::text, ''abort_settle''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.billing_history')
        AND conname = 'billing_history_operation_type_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:conversation_context_snapshots.conversation_context_snapshots_snapshot_type_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.conversation_context_snapshots')
        AND conname = 'conversation_context_snapshots_snapshot_type_check') AS object_exists_count,
    (SELECT count(*) FROM public.conversation_context_snapshots
      WHERE (((snapshot_type = ANY (ARRAY['rolling_summary'::text, 'search_digest'::text, 'compression_checkpoint'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['snapshot_type']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.conversation_context_snapshots')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.conversation_context_snapshots')
        AND conname = 'conversation_context_snapshots_snapshot_type_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((snapshot_type = ANY (ARRAY[''rolling_summary''::text, ''search_digest''::text, ''compression_checkpoint''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.conversation_context_snapshots')
        AND conname = 'conversation_context_snapshots_snapshot_type_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:payment_orders.payment_orders_billing_cycle_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_billing_cycle_check') AS object_exists_count,
    (SELECT count(*) FROM public.payment_orders
      WHERE (((billing_cycle = ANY (ARRAY['one_time'::text, 'monthly'::text, 'yearly'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['billing_cycle']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.payment_orders')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_billing_cycle_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((billing_cycle = ANY (ARRAY[''one_time''::text, ''monthly''::text, ''yearly''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_billing_cycle_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:payment_orders.payment_orders_item_type_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_item_type_check') AS object_exists_count,
    (SELECT count(*) FROM public.payment_orders
      WHERE (((item_type = ANY (ARRAY['credit_package'::text, 'membership_plan'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['item_type']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.payment_orders')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_item_type_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((item_type = ANY (ARRAY[''credit_package''::text, ''membership_plan''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_item_type_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:payment_orders.payment_orders_mode_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_mode_check') AS object_exists_count,
    (SELECT count(*) FROM public.payment_orders
      WHERE (((mode = ANY (ARRAY['payment'::text, 'subscription'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['mode']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.payment_orders')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_mode_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((mode = ANY (ARRAY[''payment''::text, ''subscription''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_mode_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:payment_orders.payment_orders_stripe_checkout_session_id_key' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_checkout_session_id_key') AS object_exists_count,
    (SELECT count(*) FROM (
        SELECT 1 FROM public.payment_orders
        WHERE stripe_checkout_session_id IS NOT NULL
        GROUP BY stripe_checkout_session_id HAVING count(*) > 1
      ) duplicate_groups) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['stripe_checkout_session_id']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.payment_orders')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_checkout_session_id_key'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'UNIQUE (stripe_checkout_session_id)') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_checkout_session_id_key' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:payment_orders.payment_orders_stripe_invoice_id_key' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_invoice_id_key') AS object_exists_count,
    (SELECT count(*) FROM (
        SELECT 1 FROM public.payment_orders
        WHERE stripe_invoice_id IS NOT NULL
        GROUP BY stripe_invoice_id HAVING count(*) > 1
      ) duplicate_groups) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['stripe_invoice_id']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.payment_orders')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_invoice_id_key'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'UNIQUE (stripe_invoice_id)') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.payment_orders')
        AND conname = 'payment_orders_stripe_invoice_id_key' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:profiles.profiles_credits_non_negative' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.profiles')
        AND conname = 'profiles_credits_non_negative') AS object_exists_count,
    (SELECT count(*) FROM public.profiles
      WHERE (((credits >= 0))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['credits']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.profiles')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.profiles')
        AND conname = 'profiles_credits_non_negative'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((credits >= 0))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.profiles')
        AND conname = 'profiles_credits_non_negative' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:scheduled_job_runs.scheduled_job_runs_status_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_status_check') AS object_exists_count,
    (SELECT count(*) FROM public.scheduled_job_runs
      WHERE (((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['error', 'status']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_status_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''running''::text, ''success''::text, ''error''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_status_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:scheduled_job_runs.scheduled_job_runs_trigger_source_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_trigger_source_check') AS object_exists_count,
    (SELECT count(*) FROM public.scheduled_job_runs
      WHERE (((trigger_source = ANY (ARRAY['manual'::text, 'cron'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['trigger_source']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_trigger_source_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((trigger_source = ANY (ARRAY[''manual''::text, ''cron''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.scheduled_job_runs')
        AND conname = 'scheduled_job_runs_trigger_source_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:user_subscriptions.user_subscriptions_billing_cycle_check' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_billing_cycle_check') AS object_exists_count,
    (SELECT count(*) FROM public.user_subscriptions
      WHERE (((billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text])))) IS FALSE) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['billing_cycle']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.user_subscriptions')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_billing_cycle_check'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'CHECK ((billing_cycle = ANY (ARRAY[''monthly''::text, ''yearly''::text])))') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_billing_cycle_check' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT 'con:user_subscriptions.user_subscriptions_stripe_subscription_id_key' AS object_key,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_stripe_subscription_id_key') AS object_exists_count,
    (SELECT count(*) FROM (
        SELECT 1 FROM public.user_subscriptions
        WHERE stripe_subscription_id IS NOT NULL
        GROUP BY stripe_subscription_id HAVING count(*) > 1
      ) duplicate_groups) AS violation_count,
    (SELECT count(*) FROM unnest(ARRAY['stripe_subscription_id']::text[]) required(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.user_subscriptions')
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_stripe_subscription_id_key'
        AND pg_catalog.pg_get_constraintdef(oid) <> 'UNIQUE (stripe_subscription_id)') AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.user_subscriptions')
        AND conname = 'user_subscriptions_stripe_subscription_id_key' AND NOT convalidated) AS invalid_object_count
  UNION ALL
  SELECT required.object_key,
    (SELECT count(*) FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = index_relation.relnamespace
      WHERE i.indrelid = pg_catalog.to_regclass('public.' || required.table_name)
        AND n.nspname = 'public' AND index_relation.relname = required.index_name) AS object_exists_count,
    0::bigint AS violation_count,
    (SELECT count(*) FROM unnest(required.columns) dependency(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.' || required.table_name)
          AND attname = dependency.column_name AND attnum > 0 AND NOT attisdropped)) AS missing_column_count,
    (SELECT count(*) FROM pg_catalog.pg_class index_relation
      JOIN pg_catalog.pg_namespace n ON n.oid = index_relation.relnamespace
      WHERE n.nspname = 'public' AND index_relation.relname = required.index_name
        AND (index_relation.relkind NOT IN ('i', 'I')
          OR pg_catalog.pg_get_indexdef(index_relation.oid) IS DISTINCT FROM required.definition))
      AS definition_mismatch_count,
    (SELECT count(*) FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = index_relation.relnamespace
      WHERE n.nspname = 'public' AND index_relation.relname = required.index_name
        AND (NOT i.indisvalid OR NOT i.indisready)) AS invalid_object_count
  FROM (VALUES
    ('idx:ai_models.idx_ai_models_is_active', 'ai_models', 'idx_ai_models_is_active',
      ARRAY['is_active']::text[],
      'CREATE INDEX idx_ai_models_is_active ON public.ai_models USING btree (is_active)'),
    ('idx:ai_models.idx_ai_models_name', 'ai_models', 'idx_ai_models_name',
      ARRAY['name']::text[],
      'CREATE INDEX idx_ai_models_name ON public.ai_models USING btree (name)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_created_at', 'ai_usage_logs', 'idx_ai_usage_logs_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_ai_usage_logs_created_at ON public.ai_usage_logs USING btree (created_at DESC)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_request_id', 'ai_usage_logs', 'idx_ai_usage_logs_request_id',
      ARRAY['request_id']::text[],
      'CREATE INDEX idx_ai_usage_logs_request_id ON public.ai_usage_logs USING btree (request_id) WHERE (request_id IS NOT NULL)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_status', 'ai_usage_logs', 'idx_ai_usage_logs_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_ai_usage_logs_status ON public.ai_usage_logs USING btree (status)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_user_created', 'ai_usage_logs', 'idx_ai_usage_logs_user_created',
      ARRAY['user_id', 'created_at']::text[],
      'CREATE INDEX idx_ai_usage_logs_user_created ON public.ai_usage_logs USING btree (user_id, created_at DESC)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_user_id', 'ai_usage_logs', 'idx_ai_usage_logs_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_ai_usage_logs_user_id ON public.ai_usage_logs USING btree (user_id)'),
    ('idx:ai_usage_logs.idx_ai_usage_logs_user_status', 'ai_usage_logs', 'idx_ai_usage_logs_user_status',
      ARRAY['status', 'user_id', 'created_at']::text[],
      'CREATE INDEX idx_ai_usage_logs_user_status ON public.ai_usage_logs USING btree (user_id, status, created_at DESC)'),
    ('idx:announcements.idx_announcements_active', 'announcements', 'idx_announcements_active',
      ARRAY['active', 'priority', 'is_deleted']::text[],
      'CREATE INDEX idx_announcements_active ON public.announcements USING btree (active, priority DESC) WHERE (is_deleted = ''false''::text)'),
    ('idx:announcements.idx_announcements_active_priority_created_at', 'announcements', 'idx_announcements_active_priority_created_at',
      ARRAY['active', 'priority', 'created_at']::text[],
      'CREATE INDEX idx_announcements_active_priority_created_at ON public.announcements USING btree (active, priority DESC, created_at DESC)'),
    ('idx:announcements.idx_announcements_is_deleted', 'announcements', 'idx_announcements_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_announcements_is_deleted ON public.announcements USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:announcements.idx_announcements_type', 'announcements', 'idx_announcements_type',
      ARRAY['announcement_type']::text[],
      'CREATE INDEX idx_announcements_type ON public.announcements USING btree (announcement_type)'),
    ('idx:billing_history.idx_billing_history_created_at', 'billing_history', 'idx_billing_history_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_billing_history_created_at ON public.billing_history USING btree (created_at DESC)'),
    ('idx:billing_history.idx_billing_history_operation_type', 'billing_history', 'idx_billing_history_operation_type',
      ARRAY['operation_type']::text[],
      'CREATE INDEX idx_billing_history_operation_type ON public.billing_history USING btree (operation_type)'),
    ('idx:billing_history.idx_billing_history_user_created', 'billing_history', 'idx_billing_history_user_created',
      ARRAY['user_id', 'created_at']::text[],
      'CREATE INDEX idx_billing_history_user_created ON public.billing_history USING btree (user_id, created_at DESC)'),
    ('idx:billing_history.idx_billing_history_user_id', 'billing_history', 'idx_billing_history_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_billing_history_user_id ON public.billing_history USING btree (user_id)'),
    ('idx:billing_history.idx_billing_history_user_operation', 'billing_history', 'idx_billing_history_user_operation',
      ARRAY['user_id', 'created_at', 'operation_type']::text[],
      'CREATE INDEX idx_billing_history_user_operation ON public.billing_history USING btree (user_id, operation_type, created_at DESC)'),
    ('idx:conversation_context_snapshots.idx_context_snapshots_conversation_created', 'conversation_context_snapshots', 'idx_context_snapshots_conversation_created',
      ARRAY['created_at', 'conversation_id']::text[],
      'CREATE INDEX idx_context_snapshots_conversation_created ON public.conversation_context_snapshots USING btree (conversation_id, created_at DESC)'),
    ('idx:conversations.idx_conversations_created_at', 'conversations', 'idx_conversations_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_conversations_created_at ON public.conversations USING btree (created_at DESC)'),
    ('idx:conversations.idx_conversations_is_deleted', 'conversations', 'idx_conversations_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_conversations_is_deleted ON public.conversations USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:conversations.idx_conversations_user_active', 'conversations', 'idx_conversations_user_active',
      ARRAY['user_id', 'is_deleted']::text[],
      'CREATE INDEX idx_conversations_user_active ON public.conversations USING btree (user_id, is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:conversations.idx_conversations_user_id', 'conversations', 'idx_conversations_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_conversations_user_id ON public.conversations USING btree (user_id)'),
    ('idx:credit_transactions.idx_credit_transactions_created_at', 'credit_transactions', 'idx_credit_transactions_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_credit_transactions_created_at ON public.credit_transactions USING btree (created_at DESC)'),
    ('idx:credit_transactions.idx_credit_transactions_type', 'credit_transactions', 'idx_credit_transactions_type',
      ARRAY['type']::text[],
      'CREATE INDEX idx_credit_transactions_type ON public.credit_transactions USING btree (type)'),
    ('idx:credit_transactions.idx_credit_transactions_user_created', 'credit_transactions', 'idx_credit_transactions_user_created',
      ARRAY['user_id', 'created_at']::text[],
      'CREATE INDEX idx_credit_transactions_user_created ON public.credit_transactions USING btree (user_id, created_at DESC)'),
    ('idx:credit_transactions.idx_credit_transactions_user_id', 'credit_transactions', 'idx_credit_transactions_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_credit_transactions_user_id ON public.credit_transactions USING btree (user_id)'),
    ('idx:credit_transactions.idx_credit_transactions_user_type_created_at', 'credit_transactions', 'idx_credit_transactions_user_type_created_at',
      ARRAY['type', 'user_id', 'created_at']::text[],
      'CREATE INDEX idx_credit_transactions_user_type_created_at ON public.credit_transactions USING btree (user_id, type, created_at DESC)'),
    ('idx:invitation_records.idx_invitation_records_created_at', 'invitation_records', 'idx_invitation_records_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_invitation_records_created_at ON public.invitation_records USING btree (created_at DESC)'),
    ('idx:invitation_records.idx_invitation_records_inviter_id', 'invitation_records', 'idx_invitation_records_inviter_id',
      ARRAY['inviter_id']::text[],
      'CREATE INDEX idx_invitation_records_inviter_id ON public.invitation_records USING btree (inviter_id)'),
    ('idx:invitation_records.idx_invitation_records_ip_address_created_at', 'invitation_records', 'idx_invitation_records_ip_address_created_at',
      ARRAY['created_at', 'ip_address']::text[],
      'CREATE INDEX idx_invitation_records_ip_address_created_at ON public.invitation_records USING btree (ip_address, created_at DESC) WHERE (ip_address IS NOT NULL)'),
    ('idx:invitation_records.idx_invitation_records_risk_level_created_at', 'invitation_records', 'idx_invitation_records_risk_level_created_at',
      ARRAY['created_at', 'risk_level']::text[],
      'CREATE INDEX idx_invitation_records_risk_level_created_at ON public.invitation_records USING btree (risk_level, created_at DESC)'),
    ('idx:invitation_records.idx_invitation_records_status', 'invitation_records', 'idx_invitation_records_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_invitation_records_status ON public.invitation_records USING btree (status)'),
    ('idx:invitation_records.idx_invitation_records_status_created_at', 'invitation_records', 'idx_invitation_records_status_created_at',
      ARRAY['status', 'created_at']::text[],
      'CREATE INDEX idx_invitation_records_status_created_at ON public.invitation_records USING btree (status, created_at DESC)'),
    ('idx:invitations.idx_invitations_created_by', 'invitations', 'idx_invitations_created_by',
      ARRAY['created_by']::text[],
      'CREATE INDEX idx_invitations_created_by ON public.invitations USING btree (created_by)'),
    ('idx:invitations.idx_invitations_status', 'invitations', 'idx_invitations_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_invitations_status ON public.invitations USING btree (status)'),
    ('idx:messages.idx_messages_conversation_created', 'messages', 'idx_messages_conversation_created',
      ARRAY['created_at', 'conversation_id']::text[],
      'CREATE INDEX idx_messages_conversation_created ON public.messages USING btree (conversation_id, created_at)'),
    ('idx:messages.idx_messages_conversation_id', 'messages', 'idx_messages_conversation_id',
      ARRAY['conversation_id']::text[],
      'CREATE INDEX idx_messages_conversation_id ON public.messages USING btree (conversation_id)'),
    ('idx:messages.idx_messages_is_deleted', 'messages', 'idx_messages_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_messages_is_deleted ON public.messages USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:modules.idx_modules_created_by', 'modules', 'idx_modules_created_by',
      ARRAY['created_by']::text[],
      'CREATE INDEX idx_modules_created_by ON public.modules USING btree (created_by)'),
    ('idx:modules.idx_modules_model_id', 'modules', 'idx_modules_model_id',
      ARRAY['model_id']::text[],
      'CREATE INDEX idx_modules_model_id ON public.modules USING btree (model_id)'),
    ('idx:payment_orders.idx_payment_orders_status', 'payment_orders', 'idx_payment_orders_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_payment_orders_status ON public.payment_orders USING btree (status)'),
    ('idx:payment_orders.idx_payment_orders_subscription_id', 'payment_orders', 'idx_payment_orders_subscription_id',
      ARRAY['stripe_subscription_id']::text[],
      'CREATE INDEX idx_payment_orders_subscription_id ON public.payment_orders USING btree (stripe_subscription_id)'),
    ('idx:payment_orders.idx_payment_orders_user_id', 'payment_orders', 'idx_payment_orders_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_payment_orders_user_id ON public.payment_orders USING btree (user_id)'),
    ('idx:payment_orders.payment_orders_stripe_checkout_session_id_key', 'payment_orders', 'payment_orders_stripe_checkout_session_id_key',
      ARRAY['stripe_checkout_session_id']::text[],
      'CREATE UNIQUE INDEX payment_orders_stripe_checkout_session_id_key ON public.payment_orders USING btree (stripe_checkout_session_id)'),
    ('idx:payment_orders.payment_orders_stripe_invoice_id_key', 'payment_orders', 'payment_orders_stripe_invoice_id_key',
      ARRAY['stripe_invoice_id']::text[],
      'CREATE UNIQUE INDEX payment_orders_stripe_invoice_id_key ON public.payment_orders USING btree (stripe_invoice_id)'),
    ('idx:profiles.idx_profiles_active', 'profiles', 'idx_profiles_active',
      ARRAY['status', 'is_deleted']::text[],
      'CREATE INDEX idx_profiles_active ON public.profiles USING btree (status) WHERE (is_deleted = ''false''::text)'),
    ('idx:profiles.idx_profiles_created_at', 'profiles', 'idx_profiles_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_profiles_created_at ON public.profiles USING btree (created_at DESC)'),
    ('idx:profiles.idx_profiles_is_deleted', 'profiles', 'idx_profiles_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_profiles_is_deleted ON public.profiles USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:profiles.idx_profiles_membership_level', 'profiles', 'idx_profiles_membership_level',
      ARRAY['membership_level']::text[],
      'CREATE INDEX idx_profiles_membership_level ON public.profiles USING btree (membership_level)'),
    ('idx:profiles.idx_profiles_role', 'profiles', 'idx_profiles_role',
      ARRAY['role']::text[],
      'CREATE INDEX idx_profiles_role ON public.profiles USING btree (role)'),
    ('idx:profiles.idx_profiles_status_created_at', 'profiles', 'idx_profiles_status_created_at',
      ARRAY['status', 'created_at']::text[],
      'CREATE INDEX idx_profiles_status_created_at ON public.profiles USING btree (status, created_at DESC)'),
    ('idx:prompts.idx_prompts_active_sort_created_at', 'prompts', 'idx_prompts_active_sort_created_at',
      ARRAY['active', 'created_at', 'sort_order']::text[],
      'CREATE INDEX idx_prompts_active_sort_created_at ON public.prompts USING btree (active, sort_order DESC, created_at DESC)'),
    ('idx:prompts.idx_prompts_category_active_sort_created_at', 'prompts', 'idx_prompts_category_active_sort_created_at',
      ARRAY['active', 'category', 'created_at', 'sort_order']::text[],
      'CREATE INDEX idx_prompts_category_active_sort_created_at ON public.prompts USING btree (category, active, sort_order DESC, created_at DESC)'),
    ('idx:prompts.idx_prompts_is_deleted', 'prompts', 'idx_prompts_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_prompts_is_deleted ON public.prompts USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:scheduled_job_runs.scheduled_job_runs_job_key_started_at_idx', 'scheduled_job_runs', 'scheduled_job_runs_job_key_started_at_idx',
      ARRAY['job_key', 'started_at']::text[],
      'CREATE INDEX scheduled_job_runs_job_key_started_at_idx ON public.scheduled_job_runs USING btree (job_key, started_at DESC)'),
    ('idx:ticket_replies.idx_ticket_replies_is_deleted', 'ticket_replies', 'idx_ticket_replies_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_ticket_replies_is_deleted ON public.ticket_replies USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:tickets.idx_tickets_category_created_at', 'tickets', 'idx_tickets_category_created_at',
      ARRAY['category', 'created_at']::text[],
      'CREATE INDEX idx_tickets_category_created_at ON public.tickets USING btree (category, created_at DESC)'),
    ('idx:tickets.idx_tickets_created_at', 'tickets', 'idx_tickets_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_tickets_created_at ON public.tickets USING btree (created_at DESC)'),
    ('idx:tickets.idx_tickets_is_deleted', 'tickets', 'idx_tickets_is_deleted',
      ARRAY['is_deleted']::text[],
      'CREATE INDEX idx_tickets_is_deleted ON public.tickets USING btree (is_deleted) WHERE (is_deleted = ''false''::text)'),
    ('idx:tickets.idx_tickets_priority', 'tickets', 'idx_tickets_priority',
      ARRAY['priority']::text[],
      'CREATE INDEX idx_tickets_priority ON public.tickets USING btree (priority)'),
    ('idx:tickets.idx_tickets_priority_created_at', 'tickets', 'idx_tickets_priority_created_at',
      ARRAY['priority', 'created_at']::text[],
      'CREATE INDEX idx_tickets_priority_created_at ON public.tickets USING btree (priority, created_at DESC)'),
    ('idx:tickets.idx_tickets_status', 'tickets', 'idx_tickets_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_tickets_status ON public.tickets USING btree (status)'),
    ('idx:tickets.idx_tickets_status_created_at', 'tickets', 'idx_tickets_status_created_at',
      ARRAY['status', 'created_at']::text[],
      'CREATE INDEX idx_tickets_status_created_at ON public.tickets USING btree (status, created_at DESC)'),
    ('idx:tickets.idx_tickets_user_id', 'tickets', 'idx_tickets_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_tickets_user_id ON public.tickets USING btree (user_id)'),
    ('idx:tickets.idx_tickets_user_status', 'tickets', 'idx_tickets_user_status',
      ARRAY['status', 'user_id', 'is_deleted']::text[],
      'CREATE INDEX idx_tickets_user_status ON public.tickets USING btree (user_id, status) WHERE (is_deleted = ''false''::text)'),
    ('idx:token_stats.idx_token_stats_conversation_id', 'token_stats', 'idx_token_stats_conversation_id',
      ARRAY['conversation_id']::text[],
      'CREATE INDEX idx_token_stats_conversation_id ON public.token_stats USING btree (conversation_id)'),
    ('idx:token_stats.idx_token_stats_created_at', 'token_stats', 'idx_token_stats_created_at',
      ARRAY['created_at']::text[],
      'CREATE INDEX idx_token_stats_created_at ON public.token_stats USING btree (created_at DESC)'),
    ('idx:token_stats.idx_token_stats_model_used', 'token_stats', 'idx_token_stats_model_used',
      ARRAY['model_used']::text[],
      'CREATE INDEX idx_token_stats_model_used ON public.token_stats USING btree (model_used)'),
    ('idx:token_stats.idx_token_stats_user_created', 'token_stats', 'idx_token_stats_user_created',
      ARRAY['user_id', 'created_at']::text[],
      'CREATE INDEX idx_token_stats_user_created ON public.token_stats USING btree (user_id, created_at DESC)'),
    ('idx:token_stats.idx_token_stats_user_id', 'token_stats', 'idx_token_stats_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_token_stats_user_id ON public.token_stats USING btree (user_id)'),
    ('idx:user_activity_logs.idx_user_activity_logs_action_type', 'user_activity_logs', 'idx_user_activity_logs_action_type',
      ARRAY['action_type']::text[],
      'CREATE INDEX idx_user_activity_logs_action_type ON public.user_activity_logs USING btree (action_type)'),
    ('idx:user_activity_logs.idx_user_activity_logs_admin_id', 'user_activity_logs', 'idx_user_activity_logs_admin_id',
      ARRAY['admin_id']::text[],
      'CREATE INDEX idx_user_activity_logs_admin_id ON public.user_activity_logs USING btree (admin_id) WHERE (admin_id IS NOT NULL)'),
    ('idx:user_activity_logs.idx_user_activity_logs_user_created', 'user_activity_logs', 'idx_user_activity_logs_user_created',
      ARRAY['user_id', 'created_at']::text[],
      'CREATE INDEX idx_user_activity_logs_user_created ON public.user_activity_logs USING btree (user_id, created_at DESC)'),
    ('idx:user_activity_logs.idx_user_activity_logs_user_id', 'user_activity_logs', 'idx_user_activity_logs_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_user_activity_logs_user_id ON public.user_activity_logs USING btree (user_id)'),
    ('idx:user_subscriptions.idx_user_subscriptions_status', 'user_subscriptions', 'idx_user_subscriptions_status',
      ARRAY['status']::text[],
      'CREATE INDEX idx_user_subscriptions_status ON public.user_subscriptions USING btree (status)'),
    ('idx:user_subscriptions.idx_user_subscriptions_user_id', 'user_subscriptions', 'idx_user_subscriptions_user_id',
      ARRAY['user_id']::text[],
      'CREATE INDEX idx_user_subscriptions_user_id ON public.user_subscriptions USING btree (user_id)'),
    ('idx:user_subscriptions.user_subscriptions_stripe_subscription_id_key', 'user_subscriptions', 'user_subscriptions_stripe_subscription_id_key',
      ARRAY['stripe_subscription_id']::text[],
      'CREATE UNIQUE INDEX user_subscriptions_stripe_subscription_id_key ON public.user_subscriptions USING btree (stripe_subscription_id)')
  ) required(object_key, table_name, index_name, columns, definition)
) precheck
ORDER BY object_key;
