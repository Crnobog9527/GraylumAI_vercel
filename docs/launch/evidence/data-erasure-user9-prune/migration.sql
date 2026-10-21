-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: controller assigns the migration number before this moves into migrations/.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE src text;
 old_query text:=$old$FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
   WHERE public.erasure_business_owner(%L,to_jsonb(x))=$1 LIMIT $2 FOR UPDATE SKIP LOCKED',t,t)$old$;
 new_query text:=$new$FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
   WHERE %s LIMIT $2 FOR UPDATE SKIP LOCKED',t,
   CASE WHEN t='runtime_executions' THEN 'x.actor_id=$1'
    ELSE format('public.erasure_business_owner(%L,to_jsonb(x))=$1',t) END)$new$;
BEGIN
 src:=pg_get_functiondef('public.account_erasure_prune_business(uuid,integer)'::regprocedure);
 IF position(new_query IN src)>0 THEN RETURN;END IF;
 IF array_length(string_to_array(src,old_query),1)<>2 THEN
  RAISE EXCEPTION 'ERASURE_PRUNE_RUNTIME_SOURCE_MISMATCH';
 END IF;
 EXECUTE replace(src,old_query,new_query);
END $patch$;
COMMIT;
