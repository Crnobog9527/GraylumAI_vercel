-- Ledger rows for content_erasure_ledger_owned: erased/live runs by id, run id in metadata, upper-case and malformed ids, missing keys.
CREATE TEMP TABLE cases AS
WITH e AS (SELECT * FROM bill2_runs WHERE content_deleted_at IS NOT NULL LIMIT 10),
 n AS (SELECT * FROM bill2_runs WHERE content_deleted_at IS NULL LIMIT 10)
SELECT jsonb_build_object('user_id',actor_id,'bill2_run_id',id) j FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'metadata',jsonb_build_object('runId',id)) FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'metadata',jsonb_build_object('usage',jsonb_build_object('runId',id))) FROM e
UNION ALL SELECT jsonb_build_object('user_id',upper(actor_id::text),'bill2_run_id',id) FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'bill2_run_id',upper(id::text)) FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'bill2_run_id',id) FROM n
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'bill2_run_id','not-a-uuid') FROM e
UNION ALL SELECT jsonb_build_object('user_id','junk','bill2_run_id',id) FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'id',gen_random_uuid()) FROM e
UNION ALL SELECT jsonb_build_object('user_id',actor_id,'metadata',jsonb_build_object('preDeductId',gen_random_uuid())) FROM e
UNION ALL SELECT '{}'::jsonb UNION ALL SELECT jsonb_build_object('user_id',null);
