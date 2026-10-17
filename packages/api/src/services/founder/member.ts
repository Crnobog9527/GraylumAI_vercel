/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  founderMemberSchema, founderStatusSchema, founderWallLink, founderWallPublicSchema, founderWallSubmitInput,
  type FounderMemberState, type FounderWallPublicEntry,
} from './schemas';

/**
 * PAY-FOUNDER PR-F1, member side. Only service-role RPCs touch the founder tables (migration 0269); the
 * profile id always comes from the signed-in session, never from input.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();

export type FounderErrorCode = 'FOUNDER_WALL_NOT_FOUNDER' | 'FOUNDER_ACCOUNT_CLOSED' | 'FOUNDER_WALL_VERSION_STALE'
  | 'FOUNDER_WALL_INPUT_INVALID' | 'FOUNDER_WALL_ENTRY_MISSING' | 'FOUNDER_WALL_ENTRY_CHANGED' | 'FOUNDER_NOT_FOUND'
  | 'FOUNDER_COMMUNITY_NOT_JOINED' | 'FOUNDER_COMMUNITY_INPUT_INVALID' | 'FOUNDER_LIVESTREAM_INPUT_INVALID'
  | 'FOUNDER_ADMIN_DENIED' | 'FOUNDER_UNAVAILABLE';
export class FounderError extends Error {
  constructor(readonly code: FounderErrorCode) { super(code); }
}
const known: FounderErrorCode[] = ['FOUNDER_WALL_NOT_FOUNDER', 'FOUNDER_ACCOUNT_CLOSED', 'FOUNDER_WALL_VERSION_STALE',
  'FOUNDER_WALL_INPUT_INVALID', 'FOUNDER_WALL_ENTRY_MISSING', 'FOUNDER_WALL_ENTRY_CHANGED', 'FOUNDER_NOT_FOUND',
  'FOUNDER_COMMUNITY_NOT_JOINED', 'FOUNDER_COMMUNITY_INPUT_INVALID', 'FOUNDER_LIVESTREAM_INPUT_INVALID', 'FOUNDER_ADMIN_DENIED'];

/** Maps a database refusal to a stable code; anything else (including stored-form CHECK failures) is generic. */
export function founderFailure(error: { message?: string; code?: string } | null | undefined): FounderError {
  const code = known.find(item => error?.message?.includes(item));
  if (code) return new FounderError(code);
  if (error?.code === '23514') return new FounderError('FOUNDER_WALL_INPUT_INVALID');
  return new FounderError('FOUNDER_UNAVAILABLE');
}

export async function callFounderRpc<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) throw founderFailure(result.error);
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw founderFailure(null);
  return parsed.data;
}

export function readFounderStatus(db: Rpc, profileId: string) {
  return callFounderRpc(db, 'pay_founder_status', { p_user: uuid.parse(profileId) }, founderStatusSchema);
}

export function readFounderMember(db: Rpc, profileId: string): Promise<FounderMemberState> {
  return callFounderRpc(db, 'founder_member_state', { a: uuid.parse(profileId) }, founderMemberSchema);
}

export function submitFounderWall(db: Rpc, profileId: string,
  input: z.input<typeof founderWallSubmitInput>): Promise<FounderMemberState> {
  const { entry, consentVersion } = founderWallSubmitInput.parse(input);
  return callFounderRpc(db, 'founder_wall_submit', { a: uuid.parse(profileId), p_entry: entry, p_version: consentVersion },
    founderMemberSchema);
}

export function withdrawFounderWall(db: Rpc, profileId: string): Promise<FounderMemberState> {
  return callFounderRpc(db, 'founder_wall_withdraw', { a: uuid.parse(profileId) }, founderMemberSchema);
}

/**
 * The public wall for the server-rendered page (PR-F2). Links are checked again at render time; a card whose
 * link no longer passes is dropped rather than shown with the link removed.
 */
export async function readFounderWallPublic(db: Rpc): Promise<FounderWallPublicEntry[]> {
  const entries = await callFounderRpc(db, 'founder_wall_public', {}, founderWallPublicSchema);
  return entries.filter(entry => (entry.productUrl === null || founderWallLink(entry.productUrl) === entry.productUrl)
    && entry.socialAccounts.every(item => founderWallLink(item.url) === item.url));
}
