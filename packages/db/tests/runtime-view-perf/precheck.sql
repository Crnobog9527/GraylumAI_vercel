-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only preflight; remote use still needs Owner authorization. Every row must be true.
BEGIN READ ONLY;
WITH expected(signature,allowed,may_be_absent) AS (VALUES
 ('public.runtime_view(uuid,uuid)',ARRAY['769e56ff54272fc2ce0abe07a339ee5c','c9b0552bbe5cac3d5a1a9394b01ff227']::text[],false),
 ('public.runtime_history_available(uuid)',ARRAY['fe9561da6f9a38b23968038ecce742cf','3de8f734b3e05bf3fcd131d9e4cb08c6']::text[],false),
 ('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)',ARRAY['ee0b34456d760952a594bb4326208c30','1513a5cf6ac6cb1b26975036a37ed3b9']::text[],false),
 ('public.runtime_session_items(uuid,uuid,uuid,text,jsonb,integer,integer)',ARRAY['8d942ec2ffb6f73d853e898349d703b4','39214d2faba91e9c4ae1113bdb10a5a2']::text[],false),
 ('public.runtime_history_availability(uuid[])',ARRAY['3c3f5f886f67f51df47187c930b95265']::text[],true)
)
SELECT signature,CASE WHEN to_regprocedure(signature) IS NULL THEN may_be_absent
 ELSE md5(pg_get_functiondef(to_regprocedure(signature)))=ANY(allowed) END AS source_matches
FROM expected ORDER BY signature;
COMMIT;
