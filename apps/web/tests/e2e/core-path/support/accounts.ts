/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CORE_ROLES, resultsDirectory, type CoreRole } from './config';

export interface Account { id: string; email: string }

const decodeSegment = (segment: string) => Buffer.from(segment, 'base64url').toString('utf8');

/**
 * The account a Playwright storageState is signed in as, read from the Supabase session cookie's access token. This is what
 * ties the spend query to the real billing accounts whichever way the session was made (state files or the login page).
 */
export function identityFromState(state: { cookies?: Array<{ name: string; value: string }> }): Account | null {
  const chunks = (state.cookies ?? []).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (chunks.length === 0) return null;
  let raw = chunks.map(cookie => cookie.value).join('');
  try {
    raw = decodeURIComponent(raw);
    if (raw.startsWith('base64-')) raw = decodeSegment(raw.slice('base64-'.length));
    const token = (JSON.parse(raw) as { access_token?: string }).access_token;
    const payload = JSON.parse(decodeSegment(token?.split('.')[1] ?? '')) as { sub?: string; email?: string };
    return payload.sub && payload.email ? { id: payload.sub, email: payload.email } : null;
  } catch {
    return null;
  }
}

const accountsFile = () => path.join(resultsDirectory, 'accounts.json');

export async function saveAccounts(accounts: Partial<Record<CoreRole, Account>>) {
  await writeFile(accountsFile(), JSON.stringify(accounts));
}

export async function readAccounts(): Promise<Partial<Record<CoreRole, Account>>> {
  return JSON.parse(await readFile(accountsFile(), 'utf8')) as Partial<Record<CoreRole, Account>>;
}

/** Every role the journeys use must be known before any paid call: an unknown account would count as zero spend. */
export async function requireAccounts(): Promise<Record<CoreRole, Account>> {
  const accounts = await readAccounts().catch(() => ({}) as Partial<Record<CoreRole, Account>>);
  const missing = CORE_ROLES.filter(role => !accounts[role]);
  if (missing.length) throw new Error(`The billing account of ${missing.join(', ')} is unknown; the spend cap cannot be enforced.`);
  return accounts as Record<CoreRole, Account>;
}
