// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
import { z } from 'zod';

const version = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const schema = z.object({
  active: version,
  keys: z.record(version, z.string()),
}).strict();

/** Never include a submitted value or JSON parser error in an exception or log. */
export function readOpeningGrantKeyring(value = process.env.OPENING_GRANT_HMAC_KEYS) {
  try {
    const parsed = schema.parse(JSON.parse(value ?? ''));
    const entries = Object.entries(parsed.keys);
    if (!parsed.keys[parsed.active] || entries.length > 8) throw new Error();
    const decoded = entries.map(([keyVersion, encoded]) => {
      const key = Buffer.from(encoded, 'base64');
      if (key.length < 32 || key.length > 64 || key.toString('base64') !== encoded) throw new Error();
      if ((process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_TARGET_ENV)
        && key.toString('utf8').startsWith('test-only-')) throw new Error();
      return { keyVersion, key };
    });
    if (new Set(entries.map(([, encoded]) => encoded)).size !== entries.length) throw new Error();
    return { active: parsed.active, keys: decoded };
  } catch {
    throw new Error('OPENING_GRANT_HMAC_KEYS missing or invalid');
  }
}

export function openingGrantKeyringIsValid(value: string): boolean {
  try {
    readOpeningGrantKeyring(value);
    return true;
  } catch {
    return false;
  }
}
