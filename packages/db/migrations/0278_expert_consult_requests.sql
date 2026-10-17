-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- EXPERT-CONSULT (Master Plan 2.1 item 51, records L/Q/R): a booking request for the Owner's
-- one-to-one diagnosis. No new table: a request is a ticket with category 'consult', so it reuses
-- the ticket admin view and replies, the account erasure guard and cleanup (0191, 0196), and the
-- soft-delete retention purge. The user's need and contact details live only in that ticket.
-- Only accounts with a confirmed positioning (0219, "已有数据基础") may ask. Clients cannot create
-- 'consult' tickets directly (tickets_insert_own keeps its category list); only these two
-- service-role functions can. No price, payment, consent switch or report access is involved.
-- No data change. No remote application without the controller's approval.
BEGIN;

-- One request per account at a time: an open or in-progress request, or any request from the
-- last 24 hours (the user may close their own ticket), is answered instead of creating another.
CREATE OR REPLACE FUNCTION public.expert_consult_pending(p_actor_id uuid) RETURNS public.tickets
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.* FROM tickets t WHERE t.user_id=p_actor_id AND t.category='consult' AND t.is_deleted='false'
  AND (t.status IN ('open','in_progress') OR t.created_at>now()-interval '24 hours')
 ORDER BY t.created_at DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.expert_consult_state(p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles; t tickets;
BEGIN
 SELECT * INTO p FROM profiles WHERE id=p_actor_id;
 IF p.id IS NULL OR p.status<>'active' OR p.is_deleted::text<>'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_actor_id) THEN
  RAISE EXCEPTION 'EXPERT_CONSULT_ACCOUNT_CLOSED' USING ERRCODE='42501';
 END IF;
 t:=expert_consult_pending(p_actor_id);
 RETURN jsonb_build_object('eligible',opc_has_confirmed_positioning(p_actor_id),
  'pending',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('ticketId',t.id,'createdAt',t.created_at) END);
END $$;

CREATE OR REPLACE FUNCTION public.expert_consult_request(p_actor_id uuid,p_need text,p_contact text,p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles; t tickets; need text:=btrim(p_need); contact text:=btrim(p_contact); place text;
BEGIN
 place:=CASE p_source WHEN 'report' THEN '报告末尾' WHEN 'pricing' THEN '价格页' WHEN 'studio' THEN '工作室版联系入口' END;
 IF p_actor_id IS NULL OR place IS NULL OR need IS NULL OR contact IS NULL
  OR char_length(need) NOT BETWEEN 10 AND 2000 OR char_length(contact) NOT BETWEEN 3 AND 200 THEN
  RAISE EXCEPTION 'EXPERT_CONSULT_INVALID' USING ERRCODE='22023';
 END IF;
 -- Serializes this account's submissions so a double click or two tabs create one request.
 PERFORM pg_advisory_xact_lock(hashtextextended('expert_consult:'||p_actor_id::text,0));
 SELECT * INTO p FROM profiles WHERE id=p_actor_id;
 IF p.id IS NULL OR p.status<>'active' OR p.is_deleted::text<>'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_actor_id) THEN
  RAISE EXCEPTION 'EXPERT_CONSULT_ACCOUNT_CLOSED' USING ERRCODE='42501';
 END IF;
 IF NOT opc_has_confirmed_positioning(p_actor_id) THEN
  RAISE EXCEPTION 'EXPERT_CONSULT_NOT_ELIGIBLE' USING ERRCODE='42501';
 END IF;
 t:=expert_consult_pending(p_actor_id);
 IF t.id IS NOT NULL THEN
  RETURN jsonb_build_object('ticketId',t.id,'createdAt',t.created_at,'created',false);
 END IF;
 -- The ticket erasure guard (0191) still runs and refuses a closing account under its own lock.
 INSERT INTO tickets(user_id,title,description,category,priority,attachments)
 VALUES(p_actor_id,'专家诊断预约',
  '需求：'||E'\n'||need||E'\n\n'||'联系方式：'||contact||E'\n\n'||'入口：'||place,'consult','high','[]'::jsonb)
 RETURNING * INTO t;
 RETURN jsonb_build_object('ticketId',t.id,'createdAt',t.created_at,'created',true);
END $$;

REVOKE ALL ON FUNCTION public.expert_consult_pending(uuid),public.expert_consult_state(uuid),
 public.expert_consult_request(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.expert_consult_state(uuid),public.expert_consult_request(uuid,text,text,text)
 TO service_role;

COMMIT;
