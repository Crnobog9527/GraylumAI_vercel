-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Pure activity-row contract. A true NULL-state worker result is ONLY a candidate:
-- the outer barrier must still check that PID's virtual-XID locks and prepared transactions.
-- Constructed pg_net/cron/parallel worker rows are not extension integration evidence.
BEGIN;
DO $$
DECLARE
  predicate regprocedure := 'public.account_erasure_activity_safe(text,text,timestamptz,xid,xid,timestamptz)'::regprocedure;
  metadata record;
  role_name text;
BEGIN
  SELECT p.provolatile, p.prosecdef, l.lanname INTO metadata
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=predicate;
  IF metadata.provolatile IS DISTINCT FROM 'i' OR metadata.prosecdef IS DISTINCT FROM false
    OR metadata.lanname IS DISTINCT FROM 'sql' THEN
    RAISE EXCEPTION 'B1b activity predicate must be IMMUTABLE SQL SECURITY INVOKER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=predicate AND acl.grantee=0 AND acl.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'B1b activity predicate must not grant PUBLIC execute';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,predicate,'EXECUTE') THEN
      RAISE EXCEPTION 'B1b activity predicate unexpectedly executable by %',role_name;
    END IF;
  END LOOP;
END $$;
SELECT 'PASS B1b activity ACL and IMMUTABLE SQL SECURITY INVOKER contract';

DO $$
DECLARE
  cutoff timestamptz := '2026-01-01 00:00:00+00';
  test record;
  actual boolean;
  tested integer := 0;
BEGIN
  FOR test IN SELECT * FROM (VALUES
    -- Known client state: a transaction-free idle connection is safe. Transactions whose
    -- start equals the cutoff are still old; only a strictly later start can pass admission.
    ('client idle outside transaction', 'client backend','idle',NULL::integer,NULL::text,NULL::text,true,true),
    ('client idle with old transaction', 'client backend','idle',-1,NULL,NULL,true,false),
    ('client idle with equal transaction', 'client backend','idle',0,NULL,NULL,true,false),
    ('client idle with future transaction', 'client backend','idle',1,NULL,NULL,true,false),
    ('client active unknown start', 'client backend','active',NULL,NULL,NULL,true,false),
    ('client active old start', 'client backend','active',-1,NULL,NULL,true,false),
    ('client active equal start', 'client backend','active',0,NULL,NULL,true,false),
    ('client active later start', 'client backend','active',1,'100','101',true,true),
    ('client idle in transaction unknown start', 'client backend','idle in transaction',NULL,NULL,NULL,true,false),
    ('client idle in transaction old start', 'client backend','idle in transaction',-1,NULL,NULL,true,false),
    ('client idle in transaction equal start', 'client backend','idle in transaction',0,NULL,NULL,true,false),
    ('client idle in transaction later start', 'client backend','idle in transaction',1,NULL,NULL,true,true),
    ('client aborted old start', 'client backend','idle in transaction (aborted)',-1,NULL,NULL,true,false),
    ('client aborted later start', 'client backend','idle in transaction (aborted)',1,NULL,NULL,true,true),
    ('client fastpath equal start', 'client backend','fastpath function call',0,NULL,NULL,true,false),
    ('client fastpath later start', 'client backend','fastpath function call',1,NULL,NULL,true,true),
    ('disabled client invisible start', 'client backend','disabled',NULL,NULL,NULL,true,false),
    ('disabled client later start', 'client backend','disabled',1,NULL,NULL,true,false),
    ('disabled worker invisible start', 'pg_net worker','disabled',NULL,NULL,NULL,true,false),
    ('unknown visible client state', 'client backend','unrecognized state',1,NULL,NULL,true,false),
    ('NULL-state client invisible transaction', 'client backend',NULL,NULL,NULL,NULL,true,false),
    ('NULL-state client later start', 'client backend',NULL,1,NULL,NULL,true,false),
    -- Every NULL/non-NULL XID and xmin combination is covered. NULL-state worker candidates
    -- require all three transaction indicators to be NULL; a newer xact_start is not enough.
    ('worker both transaction IDs NULL candidate', 'pg_net worker',NULL,NULL,NULL,NULL,true,true),
    ('worker backend_xid only', 'pg_net worker',NULL,NULL,'100',NULL,true,false),
    ('worker backend_xmin only', 'pg_net worker',NULL,NULL,NULL,'101',true,false),
    ('worker both transaction IDs visible', 'pg_net worker',NULL,NULL,'100','101',true,false),
    ('worker old transaction start', 'pg_net worker',NULL,-1,NULL,NULL,true,false),
    ('worker equal transaction start', 'pg_net worker',NULL,0,NULL,NULL,true,false),
    ('worker later transaction start', 'pg_net worker',NULL,1,NULL,NULL,true,false),
    ('worker active old transaction', 'pg_net worker','active',-1,NULL,NULL,true,false),
    ('worker active later transaction', 'pg_net worker','active',1,NULL,NULL,true,true),
    ('cron job candidate', 'pg_cron worker',NULL,NULL,NULL,NULL,true,true),
    ('parallel worker candidate', 'parallel worker',NULL,NULL,NULL,NULL,true,true),
    ('logical replication worker candidate', 'logical replication worker',NULL,NULL,NULL,NULL,true,true),
    ('future explicit worker type candidate', 'future SQL worker',NULL,NULL,NULL,NULL,true,true),
    ('empty backend type', '',NULL,NULL,NULL,NULL,true,false),
    ('empty backend type with idle state', '','idle',NULL,NULL,NULL,true,false),
    ('empty backend type with later start', '','active',1,NULL,NULL,true,false),
    ('invisible backend type with idle state', NULL,'idle',NULL,NULL,NULL,true,false),
    ('invisible backend type with later start', NULL,'active',1,NULL,NULL,true,false),
    ('all activity fields invisible', NULL,NULL,NULL,NULL,NULL,true,false),
    ('NULL cutoff on idle client', 'client backend','idle',NULL,NULL,NULL,false,false),
    ('NULL cutoff on active client', 'client backend','active',1,NULL,NULL,false,false),
    ('NULL cutoff on worker candidate', 'pg_net worker',NULL,NULL,NULL,NULL,false,false),
    ('all six fields invisible', NULL,NULL,NULL,NULL,NULL,false,false)
  ) AS cases(label,backend_type,state,start_offset,backend_xid,backend_xmin,has_cutoff,expected) LOOP
    actual := public.account_erasure_activity_safe(test.backend_type,test.state,
      CASE WHEN test.start_offset IS NOT NULL THEN cutoff + test.start_offset * interval '1 second' END,
      test.backend_xid::xid,test.backend_xmin::xid,CASE WHEN test.has_cutoff THEN cutoff END);
    IF actual IS NULL OR actual IS DISTINCT FROM test.expected THEN
      RAISE EXCEPTION 'B1b activity row %: expected %, got %',test.label,test.expected,actual;
    END IF;
    tested := tested+1;
  END LOOP;
  IF tested<>45 THEN RAISE EXCEPTION 'B1b activity row matrix unexpectedly changed size: %',tested; END IF;
END $$;
SELECT 'PASS B1b activity 45-row matrix: client time boundary, NULL-state worker candidates, XID/xmin, unknowns fail closed';
ROLLBACK;
