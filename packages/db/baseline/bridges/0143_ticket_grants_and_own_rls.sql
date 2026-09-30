-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-BASELINE bridge: runs ONLY when building an empty database from files, immediately before
-- migration 0143 of the same file name. It is never applied to staging or any existing database.
-- It reproduces a deletion staging went through outside the repository: these 0004 policies were
-- dropped there before 0143, whose fail-closed precondition only accepts the remaining nine
-- ticket policies. Bridges may only drop objects (checked by scripts/tests/db-baseline-bridges.test.mjs);
-- adding a bridge is a review blocker unless the PR explains why no migration or baseline can do it.
DROP POLICY IF EXISTS "Users can view own tickets" ON public.tickets;
DROP POLICY IF EXISTS "Users can insert own tickets" ON public.tickets;
DROP POLICY IF EXISTS "Users can update own tickets" ON public.tickets;
DROP POLICY IF EXISTS "Users can view replies on own tickets" ON public.ticket_replies;
