-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-LANGUAGE (Owner 2026-10-24, A): the language a user sets in the profile decides the language of every AI reply.
-- NULL means never set (Simplified Chinese). Written only by the server (user.setReplyLanguage, service_role) after it
-- checked the caller; read by runtime admission, compare and review starts, which freeze it into the execution.
-- No data is written; repeatable. Rollback: the code treats a missing value as Simplified Chinese, and the column can
-- be dropped once no deployed code reads it (nothing else depends on it).
BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reply_language text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_reply_language_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_reply_language_check
  CHECK (reply_language IS NULL OR reply_language IN ('zh-Hans', 'zh-Hant', 'en'));
COMMENT ON COLUMN public.profiles.reply_language IS
  'CHAT-LANGUAGE: AI reply language set by the user (zh-Hans, zh-Hant, en); NULL = never set, Simplified Chinese.';

-- Clients never write it directly: profiles_update_own also checks the nickname, which a user may never have set.
-- authenticated keeps reading its own row through the table-level SELECT and profiles_select_own.
REVOKE INSERT (reply_language), UPDATE (reply_language), REFERENCES (reply_language) ON TABLE public.profiles
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT (reply_language) ON TABLE public.profiles FROM PUBLIC, anon;
GRANT SELECT (reply_language), UPDATE (reply_language) ON TABLE public.profiles TO service_role;

COMMIT;
