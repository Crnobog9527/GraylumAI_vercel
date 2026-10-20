-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- For controller review/execution on the designated staging project ONLY, after applying the migration.
-- Exercise the repaired business RPCs, then ROLLBACK every reservation, draft and validation row.
-- No balance edits, grant rewrites, Stripe operations, model dispatch or paid calls.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE pay_upgrade_validation(actor text,initial_credits integer,effective_level text,
  initial_profiles integer,claim text,profile_start text) ON COMMIT DROP;
DO $validate$
DECLARE actor record;member jsonb;before_balance integer;profiles_count integer;registration text;
  request_id uuid;reserved record;replay record;started jsonb;claim_result text;profile_result text;
BEGIN
 IF (SELECT count(*) FROM profiles WHERE left(id::text,8) IN ('30131c0c','d46b8ba2'))<>2 THEN
  RAISE EXCEPTION 'PAY_UPGRADE_STAGING_ACTORS_REQUIRE_REVIEW';
 END IF;
 FOR actor IN SELECT id FROM profiles WHERE left(id::text,8) IN ('30131c0c','d46b8ba2') ORDER BY id LOOP
  SELECT credits INTO before_balance FROM profiles WHERE id=actor.id;
  member:=pay_common_membership_facts(actor.id)->'internal_membership';
  SELECT count(*) INTO profiles_count FROM opc_businesses WHERE actor_id=actor.id AND erased_at IS NULL;
  IF member->>'membership_level' IS DISTINCT FROM 'gold' THEN
   RAISE EXCEPTION 'PAY_UPGRADE_STAGING_EXPECTED_GOLD: %',left(actor.id::text,8);
  END IF;
  request_id:=gen_random_uuid();
  SELECT * INTO reserved FROM atomic_pre_deduct(actor.id,1,'PAY-STRIPE-MP rollback validation',request_id);
  SELECT * INTO replay FROM atomic_pre_deduct(actor.id,1,'PAY-STRIPE-MP rollback validation',request_id);
  IF reserved.balance_before<>before_balance OR reserved.balance_after<>before_balance-1
    OR replay.pre_deduct_id IS DISTINCT FROM reserved.pre_deduct_id OR NOT replay.is_idempotent THEN
   RAISE EXCEPTION 'PAY_UPGRADE_STAGING_RESERVATION_MISMATCH';
  END IF;
  claim_result:='PASS: reservation and replay';
  IF profiles_count<6 THEN
   SELECT d.registration INTO registration FROM opc_drafts d JOIN artifact_workflows w ON w.id=d.registration AND w.enabled
    WHERE d.actor_id=actor.id LIMIT 1;
   IF registration IS NULL THEN RAISE EXCEPTION 'PAY_UPGRADE_STAGING_REGISTRATION_REQUIRED'; END IF;
   started:=opc_start_b1(actor.id,gen_random_uuid(),registration,'manual',NULL,'升级恢复验证（事务撤回）','gold');
   IF started->>'businessId' IS NULL OR started->>'draftId' IS NULL THEN
    RAISE EXCEPTION 'PAY_UPGRADE_STAGING_PROFILE_RESULT_MISSING';
   END IF;
   profile_result:='PASS: actual profile created below Gold cap';
  ELSE
   BEGIN
    PERFORM opc_start_b1(actor.id,gen_random_uuid(),'recovery-cap-check','manual',NULL,'cap check','gold');
    RAISE EXCEPTION 'PAY_UPGRADE_STAGING_CAP_NOT_ENFORCED';
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'OPC_PROFILE_LIMIT' THEN RAISE; END IF;
   END;
   profile_result:='PASS: Gold cap enforced at six';
  END IF;
  INSERT INTO pay_upgrade_validation VALUES(left(actor.id::text,8),before_balance,member->>'membership_level',
    profiles_count,claim_result,profile_result);
 END LOOP;
END $validate$;
SELECT * FROM pay_upgrade_validation ORDER BY actor;
ROLLBACK;
