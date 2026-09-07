/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable table scaffolding; execution functions are copied byte-for-byte
// from the authoritative repository migrations, never reimplemented as mocks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function installWorkbenchBilling(sql, root) {
  sql(`
CREATE TABLE billing_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES profiles(id),operation_type text NOT NULL,amount integer NOT NULL,reason text,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX billing_history_terminal_pre_deduct_unique ON billing_history((metadata->>'preDeductId')) WHERE operation_type IN ('settle','refund','abort_settle') AND metadata->>'preDeductId' IS NOT NULL;
CREATE TABLE user_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,stripe_subscription_id text,membership_plan_id uuid,billing_cycle text,current_period_start timestamptz,current_period_end timestamptz,credit_release_terminated_at timestamptz);
CREATE TABLE subscription_credit_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,stripe_subscription_id text,membership_plan_id uuid,billing_cycle text,grant_type text,grant_period_key text,period_start timestamptz,period_end timestamptz,period_index integer,total_periods integer,stripe_invoice_id text,credits_granted integer,consumed_amount integer DEFAULT 0,accounting_state text DEFAULT 'trusted',status text DEFAULT 'granted',metadata jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());
CREATE TABLE ai_models(id uuid PRIMARY KEY,model_id text,name text,provider text DEFAULT 'openai',is_active text DEFAULT 'true',max_tokens integer DEFAULT 4096,input_limit integer DEFAULT 128000,api_key text,api_endpoint text,token_counting_supported text DEFAULT 'true',tokenizer_family text DEFAULT 'o200k_base',input_token_cost integer,output_token_cost integer,web_search_cost integer DEFAULT 0);
REVOKE ALL ON billing_history,user_subscriptions,subscription_credit_grants,ai_models FROM PUBLIC,anon,authenticated;
GRANT SELECT ON billing_history,ai_models TO service_role;
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
`);
  sql('CREATE TABLE conversations(id uuid PRIMARY KEY); CREATE TABLE messages(id uuid PRIMARY KEY); CREATE TABLE payment_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,amount_total integer,created_at timestamptz DEFAULT now());');
  sql(`CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES profiles(id),amount integer NOT NULL,type text NOT NULL,description text,idempotency_key text,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX idx_credit_transactions_user_idempotency_key ON credit_transactions(user_id,idempotency_key);
ALTER TABLE billing_history ADD COLUMN transaction_id uuid REFERENCES credit_transactions(id);
REVOKE ALL ON credit_transactions FROM PUBLIC,anon,authenticated; GRANT SELECT ON credit_transactions TO service_role;`);
  sql(readFileSync(resolve(root,'packages/db/migrations/0044_credit_transactions_v2_semantics.sql'),'utf8'));
  const tables = readFileSync(resolve(root, 'packages/db/migrations/0001_ai_billing_tables.sql'), 'utf8');
  for (const table of ['token_stats', 'ai_usage_logs']) {
    const start = tables.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = tables.indexOf(');', start) + 2;
    if (start < 0 || end < start) throw new Error('missing canonical usage table');
    sql(tables.slice(start, end));
  }
  sql(`ALTER TABLE token_stats ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE token_stats ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON token_stats,ai_usage_logs,payment_orders FROM PUBLIC,anon,authenticated;
GRANT SELECT ON token_stats,ai_usage_logs,payment_orders TO service_role;`);
  for (const [file, name] of [
    ['0053_refund_1b_consumed_amount_termination.sql', 'refund_1b_is_canonical_period_identity'],
    ['0061_refund_1b_expired_quarantine_repair.sql', 'atomic_pre_deduct'],
    ['0057_refund_1b_actual_refund_accounting_repair.sql', 'atomic_settle'],
    ['0057_refund_1b_actual_refund_accounting_repair.sql', 'atomic_refund'],
  ]) {
    const source = readFileSync(resolve(root, 'packages/db/migrations', file), 'utf8');
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`missing billing function ${name}`);
    const end = source.indexOf('$$;', source.indexOf('AS $$', start)) + 3;
    if (end <= start) throw new Error('invalid billing function boundary');
    sql(source.slice(start, end));
  }
  sql(`DO $$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE proname IN ('atomic_pre_deduct','atomic_settle','atomic_refund','refund_1b_is_canonical_period_identity') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',sig); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',sig); END LOOP; END $$;`);
}
