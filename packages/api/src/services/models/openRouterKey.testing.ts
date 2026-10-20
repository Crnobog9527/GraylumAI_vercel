/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetPlatformSecretCacheForTests } from '../platformSecrets/reader';
import type { PlatformSecretSlot } from '../platformSecrets/slots';

type Query = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

const VAULT_STUB = resolve(__dirname, '../../../../db/tests/platform-secrets/vault_stub.sql');

/**
 * LOCAL TEST DATABASES ONLY. Puts a synthetic key into one platform slot, loading the local Vault stand-in
 * first when the database has none.
 * Clears this process's secret cache so the next read sees the new key.
 */
export async function seedTestPlatformSecret(db: Query, slot: PlatformSecretSlot, key: string) {
  const vault = await db.query("SELECT to_regclass('vault.secrets') IS NOT NULL AS present") as { rows: Array<{ present: boolean }> };
  if (!vault.rows[0]?.present) await db.query(readFileSync(VAULT_STUB, 'utf8'));
  const name = `graylum.platform.${slot}`;
  await db.query('DELETE FROM vault.secrets WHERE name=$1', [name]);
  await db.query(`INSERT INTO platform_secrets(slot,vault_secret_id,last4,revision,updated_at)
   VALUES($2,vault.create_secret($1,$3),right($1,4),1,now())
   ON CONFLICT(slot) DO UPDATE SET vault_secret_id=excluded.vault_secret_id,last4=excluded.last4,
    revision=platform_secrets.revision+1,updated_at=now()`, [key, slot, name]);
  resetPlatformSecretCacheForTests();
}

export async function seedTestOpenRouterKey(db: Query, key: string) {
  await seedTestPlatformSecret(db, 'openrouter', key);
}

/** LOCAL TEST DATABASES ONLY. Empties a platform slot ("not filled in"). */
export async function clearTestPlatformSecret(db: Query, slot: PlatformSecretSlot) {
  const name = `graylum.platform.${slot}`;
  await db.query('DELETE FROM vault.secrets WHERE name=$1', [name]);
  await db.query('UPDATE platform_secrets SET vault_secret_id=NULL,last4=NULL,revision=revision+1,updated_at=now() WHERE slot=$1', [slot]);
  resetPlatformSecretCacheForTests();
}

export async function clearTestOpenRouterKey(db: Query) {
  await clearTestPlatformSecret(db, 'openrouter');
}
