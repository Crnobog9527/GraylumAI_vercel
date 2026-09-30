-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C11: independent client connection. The first erasure validator invocation is authenticated.
BEGIN;
DO $$ BEGIN
  PERFORM set_config('b1b.closed',(SELECT id::text FROM profiles WHERE nickname='b1b-closed'),true);
  PERFORM set_config('b1b.open',(SELECT id::text FROM profiles WHERE nickname='b1b-open'),true);
  PERFORM set_config('b1b.conv',(SELECT id::text FROM conversations WHERE title='b1b-o_conv'),true);
END $$;
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub',current_setting('b1b.open'),true); END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE n bigint;
BEGIN
  UPDATE conversations SET title='b1b owner rename' WHERE id=current_setting('b1b.conv')::uuid;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'B1b C11 ordinary client rename did not reach its guard'; END IF;
  BEGIN
    UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=now()
      WHERE id=current_setting('b1b.conv')::uuid;
    RAISE EXCEPTION 'B1b C11 open client erased content';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'ACCOUNT_ERASURE_NOT_CLOSED' THEN RAISE; END IF; END;
  BEGIN
    PERFORM account_erasure_scrub_runtime(current_setting('b1b.closed')::uuid);
    RAISE EXCEPTION 'B1b C11 client scrub permission accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'permission denied for function account_erasure_scrub_runtime' THEN RAISE; END IF;
  END;
  UPDATE conversations SET title='cross actor' WHERE user_id=current_setting('b1b.closed')::uuid;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'B1b C11 cross actor UPDATE accepted'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM account_erasure_scrub_runtime(current_setting('b1b.closed')::uuid);
    RAISE EXCEPTION 'B1b C11 anonymous scrub permission accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'permission denied for function account_erasure_scrub_runtime' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT 'PASS B1b C11 fresh authenticated/anon session: owner rename, open erasure/cross actor/client scrub denied';
ROLLBACK;
