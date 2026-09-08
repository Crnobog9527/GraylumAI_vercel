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
  sql(`ALTER TABLE profiles ADD COLUMN avatar_url text; GRANT SELECT(avatar_url) ON profiles TO authenticated;
ALTER TABLE ai_models ADD COLUMN description text, ADD COLUMN enable_web_search text DEFAULT 'false', ADD COLUMN updated_at timestamptz DEFAULT now(), ADD COLUMN token_counting_method text DEFAULT 'verified_openai_tokenizer';
GRANT SELECT(id,name,model_id,provider,description,enable_web_search,max_tokens,is_active) ON ai_models TO authenticated; CREATE POLICY ai_models_active ON ai_models FOR SELECT TO authenticated USING(is_active='true');
ALTER TABLE modules ADD COLUMN description text DEFAULT 'Synthetic local module', ADD COLUMN full_description text DEFAULT '', ADD COLUMN icon text DEFAULT 'Bot', ADD COLUMN features jsonb DEFAULT '[]', ADD COLUMN examples jsonb DEFAULT '[]', ADD COLUMN preparation_questions jsonb DEFAULT '[]', ADD COLUMN usage_count integer DEFAULT 0, ADD COLUMN credits_multiplier numeric DEFAULT 1, ADD COLUMN sort_order integer DEFAULT 0, ADD COLUMN is_featured boolean DEFAULT false, ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now(), ADD COLUMN image_url text, ADD COLUMN badge_type text, ADD COLUMN badge_text text, ADD COLUMN credits_display text, ADD COLUMN link_url text, ADD COLUMN link_module_id uuid;
GRANT SELECT(id,title,description,full_description,icon,category,platform,features,examples,preparation_questions,usage_count,credits_multiplier,sort_order,is_featured,active,created_at,updated_at,image_url,badge_type,badge_text,credits_display,link_url,link_module_id) ON modules TO anon,authenticated;`);
  sql(`CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES profiles(id),title text NOT NULL DEFAULT 'Chat',model_id uuid,summary text,summary_tokens integer,summary_updated_at timestamptz,summary_metadata jsonb,is_deleted text NOT NULL DEFAULT 'false',deleted_at timestamptz,created_at timestamptz DEFAULT now()); CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations(id),role text,content text,is_deleted text NOT NULL DEFAULT 'false',created_at timestamptz DEFAULT now()); CREATE TABLE payment_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,amount_total integer,created_at timestamptz DEFAULT now());`);
  sql(`CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES profiles(id),amount integer NOT NULL,type text NOT NULL,description text,idempotency_key text,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX idx_credit_transactions_user_idempotency_key ON credit_transactions(user_id,idempotency_key);
ALTER TABLE billing_history ADD COLUMN transaction_id uuid REFERENCES credit_transactions(id);
REVOKE ALL ON credit_transactions FROM PUBLIC,anon,authenticated; GRANT SELECT ON credit_transactions TO service_role;`);
  sql(readFileSync(resolve(root,'packages/db/migrations/0044_credit_transactions_v2_semantics.sql'),'utf8'));
  const rls = readFileSync(resolve(root, 'packages/db/migrations/0002_enable_rls_all_tables.sql'), 'utf8');
  for (const policy of ['conversations_select_own','conversations_insert_own','conversations_update_own','conversations_delete_own','messages_select_own','messages_insert_own','messages_delete_own']) {
    const start=rls.indexOf(`CREATE POLICY "${policy}"`); const end=rls.indexOf(';',start)+1;
    if(start<0||end<=start)throw new Error('missing canonical chat policy'); sql(rls.slice(start,end));
  }
  sql('ALTER TABLE conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE messages ENABLE ROW LEVEL SECURITY; GRANT SELECT,INSERT,UPDATE,DELETE ON conversations,messages TO authenticated,service_role;');
  sql('ALTER TABLE messages ADD COLUMN deleted_at timestamptz');
  const deletion = readFileSync(resolve(root,'packages/db/migrations/0050_sec1_privileged_rpc_execute_posture_closure.sql'),'utf8');
  const deletionStart=deletion.indexOf('CREATE OR REPLACE FUNCTION public.soft_delete_conversation('),deletionEnd=deletion.indexOf('$$;',deletionStart)+3;
  if(deletionStart<0||deletionEnd<=deletionStart)throw new Error('missing canonical conversation deletion');
  sql(deletion.slice(deletionStart,deletionEnd));
  sql('REVOKE ALL ON FUNCTION public.soft_delete_conversation(uuid,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.soft_delete_conversation(uuid,uuid) TO authenticated');
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
GRANT SELECT ON token_stats,ai_usage_logs,payment_orders TO service_role; GRANT INSERT ON token_stats,ai_usage_logs TO service_role;
GRANT SELECT ON token_stats TO authenticated; CREATE POLICY token_stats_select_own ON token_stats FOR SELECT TO authenticated USING(user_id=auth.uid());`);
  for (const [file, name] of [
    ['0053_refund_1b_consumed_amount_termination.sql', 'refund_1b_is_canonical_period_identity'],
    ['0061_refund_1b_expired_quarantine_repair.sql', 'atomic_pre_deduct'],
    ['0057_refund_1b_actual_refund_accounting_repair.sql', 'atomic_settle'],
    ['0057_refund_1b_actual_refund_accounting_repair.sql', 'atomic_refund'],
    ['0058_refund_1b_canonical_metadata_merge_repair.sql', 'atomic_finalize_ai_success'],
    ['0059_refund_1b_failure_period_metadata_repair.sql', 'atomic_finalize_ai_failure'],
    ['0058_refund_1b_canonical_metadata_merge_repair.sql', 'atomic_finalize_ai_abort'],
  ]) {
    const source = readFileSync(resolve(root, 'packages/db/migrations', file), 'utf8');
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`missing billing function ${name}`);
    const end = source.indexOf('$$;', source.indexOf('AS $$', start)) + 3;
    if (end <= start) throw new Error('invalid billing function boundary');
    sql(source.slice(start, end));
  }
  sql(`DO $$ DECLARE sig text; BEGIN FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE proname IN ('atomic_pre_deduct','atomic_settle','atomic_refund','refund_1b_is_canonical_period_identity','atomic_finalize_ai_success','atomic_finalize_ai_failure','atomic_finalize_ai_abort') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',sig); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',sig); END LOOP; END $$;`);
}
