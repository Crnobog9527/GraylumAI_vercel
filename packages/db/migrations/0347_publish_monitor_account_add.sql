-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR: add a brand account from the data review page, without first adopting a topic
-- (Owner 2026-10-23: "在数据复盘的我的账号里可以直接添加品牌账号，不必先采用选题，上线前做").
--   * A brand account (opc_accounts + its artifact_projects row) used to be created only when topics were adopted
--     (opc_handoff). The connection to Post for Me hangs on that account, so a user who never adopted a topic could
--     neither connect nor publish. This function creates the same two rows directly.
--   * It never creates a business (positioning profile) and so never touches the profile limit: the account hangs on
--     one of the caller's own businesses that already has a confirmed positioning (opc_businesses.current_source_version_id,
--     which opc_accounts.source_version_id needs). A caller without such a business is told so, not worked around.
--   * Replayable by (business, platform, account name): the same request returns the existing account (created=false).
--     A business keeps one account per platform (membership rule), so another name on the same platform is refused; an
--     account name already held by another of the caller's businesses is refused (opc_accounts is unique per actor,
--     platform and name).
--   * The account is an ordinary opc_accounts row: account erasure, business erasure and the library see it as they see
--     every account (they key on actor_id / business_id), so nothing new to clean.
-- Compatibility: one new function; no existing object changes. Repeatable: CREATE OR REPLACE.
-- Recovery: DROP FUNCTION public.publish_monitor_account_add(uuid,uuid,text,text); accounts it created stay valid
-- ordinary accounts (they can be removed by the normal erasure paths).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_account_add(a uuid,p_business uuid,p_platform text,p_account text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b opc_businesses;ac opc_accounts;v artifact_versions;src artifact_projects;
 plat text:=btrim(coalesce(p_platform,''));acct text:=lower(btrim(coalesce(p_account,'')));created boolean:=false;
BEGIN
 PERFORM publish_monitor_actor(a);
 -- Same lock opc_handoff takes, so a concurrent topic adoption and this function never create the same account twice.
 PERFORM pg_advisory_xact_lock(hashtextextended(a::text,107));
 IF p_business IS NULL OR plat !~ '^[a-z0-9_-]{1,32}$' OR acct !~ '^[a-z0-9][a-z0-9._:-]{0,127}$' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT * INTO b FROM opc_businesses WHERE id=p_business AND actor_id=a AND erased_at IS NULL AND archived_at IS NULL FOR SHARE;
 IF b.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND' USING ERRCODE='42501'; END IF;
 -- A replay (or a topic adoption that already made it) returns the existing account.
 SELECT * INTO ac FROM opc_accounts WHERE actor_id=a AND platform=plat AND account_key=acct AND erased_at IS NULL;
 IF ac.project_id IS NOT NULL THEN
  IF ac.business_id IS DISTINCT FROM b.id THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_EXISTS_ELSEWHERE' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM opc_accounts WHERE actor_id=a AND business_id=b.id AND platform=plat AND erased_at IS NULL) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_PLATFORM_HAS_ACCOUNT' USING ERRCODE='23505';
  END IF;
  -- opc_accounts.source_version_id is required: the business's current confirmed positioning.
  SELECT * INTO v FROM artifact_versions WHERE id=b.current_source_version_id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_BUSINESS_NOT_READY' USING ERRCODE='55000'; END IF;
  SELECT * INTO src FROM artifact_projects WHERE id=v.project_id;
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,work_title)
   VALUES(gen_random_uuid(),a,src.module_id,src.skill_id,'account',acct) RETURNING id INTO ac.project_id;
  INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id)
   VALUES(ac.project_id,a,plat,acct,v.id,b.id) RETURNING * INTO ac;
  created:=true;
 END IF;
 RETURN jsonb_build_object('accountProjectId',ac.project_id,'businessId',ac.business_id,'platform',ac.platform,
  'account',ac.account_key,'created',created);
END $$;

REVOKE ALL ON FUNCTION public.publish_monitor_account_add(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_account_add(uuid,uuid,text,text) TO service_role;
COMMIT;
