-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local-only helpers for the A2 cases (loaded after the full build, with the B2a and D7 fixtures).
CREATE SCHEMA IF NOT EXISTS a2_test;
-- d7_test.artifacts leaves the work project unlinked; real handoffs link it to the account project.
CREATE OR REPLACE FUNCTION a2_test.link(art jsonb) RETURNS jsonb LANGUAGE sql AS $$
 UPDATE artifact_projects w SET source_project_id=i.account_project_id FROM opc_items i
 WHERE i.work_item_id=(art->>'workItem')::uuid AND w.id=i.work_item_id RETURNING art;
$$;
