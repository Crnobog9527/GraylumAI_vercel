-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Disposable local full-schema fixture, before the repair. Everything rolls back.
BEGIN;
DO $$
DECLARE a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); r record; failed boolean := false;
BEGIN
  INSERT INTO profiles(id,email,credits) VALUES(a,'inviter@example.test',0),(b,'invitee@example.test',0);
  INSERT INTO invitations(code,created_by,status) VALUES('REPRO-1',a,'active'),('REPRO-2',a,'active');
  PERFORM atomic_claim_invitation_code('REPRO-1',b,'invitee@example.test','rewarded','low',NULL,50,30);
  PERFORM atomic_claim_invitation_code('REPRO-2',b,'invitee@example.test','rewarded','low',NULL,50,30);
  IF (SELECT credits FROM profiles WHERE id=b) <> 60 THEN RAISE EXCEPTION 'multi-code reproduction missing'; END IF;
  IF (SELECT count(*) FROM invitation_records WHERE invitee_id=b) <> 2 THEN RAISE EXCEPTION 'two bindings missing'; END IF;
  -- No opening decision was required, and the same account got both rewards.
  PERFORM atomic_apply_invitation_rebate(b,200,'repro-spend',5);
  BEGIN
    PERFORM atomic_apply_invitation_rebate(b,200,'repro-spend',5);
  EXCEPTION WHEN datatype_mismatch THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'bigint replay mismatch not reproduced'; END IF;
  RAISE NOTICE 'PASS reproduced multi-code/missing-opening rewards and bigint replay error';
END $$;
ROLLBACK;
