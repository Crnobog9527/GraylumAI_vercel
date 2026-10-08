-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Preserve existing attachment authority for account-erasure Storage verification.
-- Already purged history is not reconstructed; this is not upload-drain proof.
BEGIN;
CREATE OR REPLACE FUNCTION public.account_erasure_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject uuid; p public.profiles; path text;
BEGIN
 IF TG_TABLE_NAME='tickets' THEN subject:=NEW.user_id;
 ELSE SELECT user_id INTO subject FROM tickets WHERE id=NEW.ticket_id; END IF;
 -- The service-only retention function may erase expired body fields while
 -- retaining exactly the original attachment metadata. Existing column grants
 -- still deny direct client/service body updates. No metadata/refill bypass.
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='tickets' THEN
   IF OLD.is_deleted='true' AND OLD.deleted_at IS NOT NULL AND NEW.title='' AND NEW.description=''
    AND to_jsonb(NEW)-ARRAY['title','description']=to_jsonb(OLD)-ARRAY['title','description'] THEN RETURN NEW; END IF;
  ELSE
   IF NEW.content=''
    AND (OLD.is_deleted='true' AND OLD.deleted_at IS NOT NULL OR EXISTS(
     SELECT 1 FROM tickets t WHERE t.id=OLD.ticket_id AND t.is_deleted='true' AND t.deleted_at IS NOT NULL))
    AND to_jsonb(NEW)-'content'=to_jsonb(OLD)-'content' THEN RETURN NEW; END IF;
  END IF;
 END IF;
 -- Deny new references to objects owned by a closed subject or already attached to its
 -- tickets, including administrator-owned paths. Existing shared references are not deleted.
 IF NEW.attachments IS NOT NULL AND jsonb_typeof(NEW.attachments)='array' THEN
  FOR path IN SELECT value FROM jsonb_array_elements_text(NEW.attachments) LOOP
   IF EXISTS(SELECT 1 FROM account_erasure_requests e WHERE split_part(path,'/',1)=e.profile_id::text)
    OR EXISTS(SELECT 1 FROM tickets t JOIN account_erasure_requests e ON e.profile_id=t.user_id
      WHERE coalesce(t.attachments,'[]'::jsonb) ? path)
    OR EXISTS(SELECT 1 FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
      JOIN account_erasure_requests e ON e.profile_id=t.user_id WHERE coalesce(r.attachments,'[]'::jsonb) ? path) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ATTACHMENT_CLOSED' USING ERRCODE='42501';
   END IF;
  END LOOP;
 END IF;
 IF subject IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM profiles WHERE id=subject FOR SHARE;
 IF p.id IS NULL OR p.status='deleted' OR p.is_deleted::text='true'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=subject) THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_TICKET_CLOSED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.purge_deleted_records(p_days_old integer DEFAULT 30)
RETURNS TABLE(table_name text,deleted_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cutoff timestamptz; removed bigint;
BEGIN
 IF p_days_old IS NULL OR p_days_old<1 THEN RAISE EXCEPTION 'invalid retention period'; END IF;
 cutoff:=now()-make_interval(days=>p_days_old);
 -- Serialize with confirmation's profile UPDATE before reading erasure facts.
 -- In READ COMMITTED the later DELETE statements see the committed closure;
 -- stronger stale snapshots abort on a concurrently changed profile, never skip it.
 PERFORM p.id FROM profiles p WHERE p.id IN (
  SELECT t.user_id FROM tickets t WHERE t.is_deleted='true' AND t.deleted_at<cutoff
  UNION SELECT r.user_id FROM ticket_replies r WHERE r.is_deleted='true' AND r.deleted_at<cutoff
  UNION SELECT t.user_id FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
   WHERE r.is_deleted='true' AND r.deleted_at<cutoff
  UNION SELECT r.user_id FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
   WHERE t.is_deleted='true' AND t.deleted_at<cutoff
 ) ORDER BY p.id FOR SHARE;
 DELETE FROM messages WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'messages'::text,removed;
 DELETE FROM conversations WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'conversations'::text,removed;
 -- Do not extend body retention merely to retain original path/owner evidence.
 UPDATE ticket_replies r SET content='' WHERE
  (r.is_deleted='true' AND r.deleted_at<cutoff AND
   (EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=r.user_id)
    OR EXISTS(SELECT 1 FROM tickets t JOIN account_erasure_requests e ON e.profile_id=t.user_id WHERE t.id=r.ticket_id)))
  OR EXISTS(SELECT 1 FROM tickets t WHERE t.id=r.ticket_id AND t.is_deleted='true' AND t.deleted_at<cutoff
   AND (EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=t.user_id)
    OR EXISTS(SELECT 1 FROM ticket_replies sibling JOIN account_erasure_requests e ON e.profile_id=sibling.user_id
     WHERE sibling.ticket_id=t.id)));
 -- Parent expiration formerly cascaded to every reply, even fresh/non-deleted ones.
 -- Preserve that body-erasure boundary while retaining only original reference metadata.
 UPDATE tickets t SET title='',description='' WHERE t.is_deleted='true' AND t.deleted_at<cutoff
  AND (EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=t.user_id)
   OR EXISTS(SELECT 1 FROM ticket_replies r JOIN account_erasure_requests e ON e.profile_id=r.user_id WHERE r.ticket_id=t.id));
 -- Retain raw attachment ownership until the existing Storage-verified cleanup
 -- removes these rows. No new retention period or separate manifest authority.
 DELETE FROM ticket_replies r WHERE r.is_deleted='true' AND r.deleted_at<cutoff
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=r.user_id)
  AND NOT EXISTS(SELECT 1 FROM tickets t JOIN account_erasure_requests e ON e.profile_id=t.user_id
    WHERE t.id=r.ticket_id);
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'ticket_replies'::text,removed;
 DELETE FROM tickets t WHERE t.is_deleted='true' AND t.deleted_at<cutoff
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=t.user_id)
  AND NOT EXISTS(SELECT 1 FROM ticket_replies r JOIN account_erasure_requests e ON e.profile_id=r.user_id
    WHERE r.ticket_id=t.id);
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'tickets'::text,removed;
 DELETE FROM prompts WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'prompts'::text,removed;
 DELETE FROM announcements WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'announcements'::text,removed;
END $$;
REVOKE ALL ON FUNCTION public.purge_deleted_records(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.purge_deleted_records(integer) TO service_role;
COMMIT;
