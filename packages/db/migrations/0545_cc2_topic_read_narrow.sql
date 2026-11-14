-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CONTENT-CONVERSATION-2 follow-up (review of #1993, reminder 2). Number 0545 assigned by the controller.
--   * opc_topic_read: whole current definition (0541); the loop that finds the bound version's strategy-history ordinal reads only
--     the accounts of this draft's business (opc_draft_businesses) instead of every account of the user, and its exception
--     handler skips only an account that cannot be read (CONTENT_ERASED, OPC_DENIED) and re-raises anything else. The answer,
--     its keys and the fallback count are unchanged.
-- Compatibility: same signature, same answer for every readable case. Repeatable: CREATE OR REPLACE only.
-- Recovery: re-apply the 0541 definition (packages/db/functions/opc/opc_topic_read.sql at the parent commit).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_topic_read(p_actor_id uuid, p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;w opc_topic_workspaces;o opc_topic_openings;v artifact_versions;ordinal integer;acct uuid;
BEGIN
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 result:=opc_topic_read_before_opening(p_actor_id,p_draft_id);
 IF NOT (result->>'bound')::boolean THEN RETURN result;END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO v FROM artifact_versions WHERE id=w.source_version_id;
 SELECT * INTO o FROM opc_topic_openings WHERE draft_id=p_draft_id;
 -- CONTENT-CONVERSATION-2 (0541): the version shown to the user is the one the library rail and the strategy history show, its
 -- ordinal in an account's strategy history (opc_account_strategy_history 'version'), not the project's publish counter: staging
 -- validation batch 6 saw "绑定 v10" here against "当前 v9" in the rail. The first account of this user whose history holds the bound
 -- version gives it; an account that cannot be read is skipped. With none, the count of allowed versions of the bound version's
 -- project up to it (the shared part of every account's history).
 -- 0545 (review of #1993): only the accounts of this draft's business are read (the bound version is theirs), and only the two
 -- refusals of an account that cannot be read (CONTENT_ERASED, OPC_DENIED) are skipped; any other error is raised as before.
 FOR acct IN SELECT a.project_id FROM opc_accounts a JOIN opc_draft_businesses db ON db.business_id=a.business_id
   WHERE db.draft_id=p_draft_id AND a.actor_id=p_actor_id ORDER BY a.project_id LOOP
  BEGIN
   SELECT (h->>'version')::integer INTO ordinal FROM jsonb_array_elements(opc_account_strategy_history(p_actor_id,acct)) h
    WHERE h->>'id'=w.source_version_id::text;
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM NOT IN ('CONTENT_ERASED','OPC_DENIED') THEN RAISE; END IF;
   ordinal:=NULL;
  END;
  EXIT WHEN ordinal IS NOT NULL;
 END LOOP;
 IF ordinal IS NULL AND v.id IS NOT NULL THEN
  SELECT count(*)::integer INTO ordinal FROM artifact_versions x WHERE x.project_id=v.project_id
   AND (x.created_at,x.id)<=(v.created_at,v.id) AND opc_source_allowed(p_actor_id,x.id);
 END IF;
 RETURN result||jsonb_build_object('sourceRoundId',v.round_id,'sourceVersion',ordinal,
  'opening',CASE WHEN o.request_id IS NOT NULL THEN jsonb_build_object('draftId',p_draft_id,'requestId',o.request_id,'input',o.input,'executionId',(SELECT t.request_id FROM turns t WHERE t.actor_id=p_actor_id AND t.session_id=w.session_id AND t.request_id=o.request_id)) ELSE NULL END);
END $function$;

COMMIT;
