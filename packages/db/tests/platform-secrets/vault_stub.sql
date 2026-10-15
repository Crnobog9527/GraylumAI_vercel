-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LOCAL-ONLY Supabase Vault stand-in for the ADMIN-SECRETS database test. Never apply it to staging or
-- production: Supabase ships the real extension there. Same names, arguments and grants as
-- supabase_vault 0.3.1 on staging (read 2026-10-14); encryption is pgcrypto with a fixed test-only key.
CREATE SCHEMA IF NOT EXISTS vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
GRANT USAGE ON SCHEMA vault TO service_role;

CREATE TABLE vault.secrets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text,
 description text NOT NULL DEFAULT '',
 secret text NOT NULL,
 key_id uuid,
 nonce bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX secrets_name_idx ON vault.secrets(name) WHERE name IS NOT NULL;

CREATE VIEW vault.decrypted_secrets AS
 SELECT id,name,description,secret,
  convert_from(extensions.pgp_sym_decrypt_bytea(decode(secret,'base64'),'local-test-vault-root-key'),'utf8')
   AS decrypted_secret,key_id,nonce,created_at,updated_at
 FROM vault.secrets;

CREATE FUNCTION vault.create_secret(new_secret text,new_name text DEFAULT NULL,
 new_description text DEFAULT '',new_key_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 INSERT INTO vault.secrets(name,description,secret,key_id)
 VALUES(new_name,coalesce(new_description,''),
  encode(extensions.pgp_sym_encrypt_bytea(convert_to(new_secret,'utf8'),'local-test-vault-root-key'),'base64'),
  new_key_id)
 RETURNING id
$$;

CREATE FUNCTION vault.update_secret(secret_id uuid,new_secret text DEFAULT NULL,new_name text DEFAULT NULL,
 new_description text DEFAULT NULL,new_key_id uuid DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE vault.secrets SET
  secret=CASE WHEN new_secret IS NULL THEN secret ELSE
   encode(extensions.pgp_sym_encrypt_bytea(convert_to(new_secret,'utf8'),'local-test-vault-root-key'),'base64') END,
  name=coalesce(new_name,name),description=coalesce(new_description,description),
  key_id=coalesce(new_key_id,key_id),updated_at=now()
 WHERE id=secret_id
$$;

REVOKE ALL ON TABLE vault.secrets,vault.decrypted_secrets FROM PUBLIC,anon,authenticated;
GRANT SELECT,DELETE ON TABLE vault.secrets,vault.decrypted_secrets TO service_role;
REVOKE ALL ON FUNCTION vault.create_secret(text,text,text,uuid),
 vault.update_secret(uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION vault.create_secret(text,text,text,uuid),
 vault.update_secret(uuid,text,text,text,uuid) TO service_role;
