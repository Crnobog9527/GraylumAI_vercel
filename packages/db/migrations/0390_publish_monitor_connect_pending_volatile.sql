-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR fix: the connect confirmation page returned 500 on every attempt in staging (2026-10-25).
--   * publish_monitor_connect_pending was declared STABLE, yet it calls publish_monitor_actor, which locks the profile row
--     (SELECT ... FOR UPDATE). PostgREST runs STABLE and IMMUTABLE functions in a READ ONLY transaction, where a row
--     lock is refused (SQLSTATE 25006: "cannot execute SELECT FOR UPDATE in a read-only transaction"). The server turned
--     that into PUBLISH_MONITOR_UNAVAILABLE, so the page said "连接暂时没有完成" and the user could never confirm an
--     account. Every local test calls the function through a plain read-write connection, which is why none caught it.
--   * The body does not change; only the volatility does (VOLATILE is what a function that locks a row must be).
--     It still writes nothing. Grants are kept by CREATE OR REPLACE.
--   * It is the only publish_monitor function that is STABLE and reaches publish_monitor_actor (checked against the staging
--     catalog); the catalog test below keeps it that way.
-- Compatibility: same signature and result; callers need no change. Repeatable: CREATE OR REPLACE.
-- Recovery: re-create it with STABLE (the old, broken behavior); nothing else depends on the volatility.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_connect_pending(a uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE req social_connect_requests; acct opc_accounts; business_name text;
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO req FROM social_connect_requests WHERE id=p_request_id AND actor_id=a;
 IF req.id IS NULL OR req.state<>'pending_confirm' OR req.confirm_expires_at<=clock_timestamp()
  OR req.target_account_project_id IS NULL THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REQUEST_INVALID' USING ERRCODE='PT409'; END IF;
 SELECT * INTO acct FROM opc_accounts WHERE project_id=req.target_account_project_id AND actor_id=a;
 SELECT name INTO business_name FROM opc_businesses WHERE id=acct.business_id AND actor_id=a;
 RETURN jsonb_build_object('requestId',req.id,'platform',req.platform,'permissions',to_jsonb(req.permissions),
  'confirmExpiresAt',req.confirm_expires_at,
  'target',jsonb_build_object('accountProjectId',acct.project_id,'platform',acct.platform,'accountKey',acct.account_key,
   'businessName',business_name),
  'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('providerAccountId',x,'kind',
    CASE WHEN c.id IS NULL THEN 'new'
     WHEN c.actor_id=a AND c.account_project_id=req.target_account_project_id AND c.status<>'deleting' THEN 'target'
     ELSE 'unavailable' END) ORDER BY o)
   FROM unnest(req.candidate_provider_ids) WITH ORDINALITY u(x,o)
   LEFT JOIN social_connections c ON c.provider_account_id=x),'[]'::jsonb));
END $$;

COMMIT;
