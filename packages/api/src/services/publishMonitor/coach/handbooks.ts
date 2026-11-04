/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH block C: loads the platform handbooks (machine-readable part, `handbook/<platform>.yaml`) of the coach Skill package into
 * the Map the review pack is built with. The text itself lives only in the private repository graylum-skills and the published package;
 * this repository holds the loader and the schema, never a handbook. A handbook that cannot be read or fails the schema is left out:
 * that platform is then diagnosed on the user's own data only, which is exactly what a missing handbook means to buildPack.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../../lib/logger';
import { errorCode, logSwallowed } from '../../../lib/swallow';
import { handbookSchema, type Handbook } from './funnel';

/** Platforms that have a machine-readable handbook; the others (YouTube, Instagram, Xiaohongshu) only have a draft text for now. */
export const HANDBOOK_PLATFORMS = ['douyin', 'tiktok'] as const;
/** Env name of the pinned package: JSON {skillId, revisionId, packageHash}. Unset: no handbooks, as before this block. */
export const HANDBOOK_PACKAGE_ENV = 'PUBLISH_MONITOR_HANDBOOK_PACKAGE';

const packageSchema = z.object({ skillId: z.string().uuid(), revisionId: z.string().uuid(), packageHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type HandbookPackage = z.infer<typeof packageSchema>;
export type HandbookReader = (path: string) => Promise<string | null>;

/** The pinned package of this deployment, or null when none is configured or the setting is malformed (logged, never thrown). */
export function readHandbookPackage(env: Record<string, string | undefined>): HandbookPackage | null {
  const raw = env[HANDBOOK_PACKAGE_ENV];
  if (!raw) return null;
  try { return packageSchema.parse(JSON.parse(raw)); }
  catch (error) { logSwallowed('coach_handbook_package_invalid', error, { category: 'billing' }); return null; }
}

/** One handbook file: valid JSON, valid schema, and the platform it claims is the platform it was read for. Null otherwise. */
export function parseHandbook(text: string, platform: string): Handbook | null {
  try {
    const handbook = handbookSchema.parse(JSON.parse(text));
    return handbook.platform === platform ? handbook : null;
  } catch { return null; }
}

/** A Skill package only holds Markdown and YAML files, so a handbook is a `.yaml` file whose text is strict JSON (valid YAML too).
 * Reads `handbook/<platform>.yaml` of every platform through `read`; a platform that is missing, unreadable or invalid is left out. */
export async function loadHandbooks(read: HandbookReader, platforms: readonly string[] = HANDBOOK_PLATFORMS): Promise<Map<string, Handbook>> {
  const loaded = await Promise.all(platforms.map(async platform => {
    let text: string | null;
    try { text = await read(`handbook/${platform}.yaml`); }
    catch (error) { logSwallowed('coach_handbook_unavailable', error, { category: 'billing', platform }); return null; }
    if (text === null) return null;
    const handbook = parseHandbook(text, platform);
    if (!handbook) logger.warn('billing', 'coach_handbook_invalid', { platform });
    return handbook;
  }));
  return new Map(loaded.flatMap(handbook => handbook ? [[handbook.platform, handbook] as const] : []));
}

/**
 * The pinned package's files through fusion_review_skill_file (0256, service role only, no user identity): the same reader the review
 * jury uses. Skill id, revision and hash must all match, the Skill must be published and the revision not revoked.
 */
export function packageReader(admin: Pick<SupabaseClient, 'rpc'>, pack: HandbookPackage): HandbookReader {
  return async path => {
    const { data, error } = await admin.rpc('fusion_review_skill_file', { p_skill_id: pack.skillId, p_revision_id: pack.revisionId,
      p_package_hash: pack.packageHash, p_path: path });
    if (error) throw new Error('COACH_HANDBOOK_READ_FAILED');
    // The service answers a file as base64; anything else means the path is not in the package.
    return typeof data === 'string' ? Buffer.from(data, 'base64').toString('utf8') : null;
  };
}

/**
 * The handbooks of this deployment's coach package. Never throws: no pinned package, or a package that cannot be read, is an empty
 * Map (every platform diagnosed on its own data, as when no handbook existed).
 */
export async function loadCoachHandbooks(admin: Pick<SupabaseClient, 'rpc'>, env: Record<string, string | undefined>):
  Promise<Map<string, Handbook>> {
  const pack = readHandbookPackage(env);
  if (!pack) return new Map();
  try {
    // Read on every review (two small files, once a week per brand): fusion_review_skill_file re-checks the publication and
    // revocations each time, so a revoked handbook stops being used at once and every instance gives the same answer.
    return await loadHandbooks(packageReader(admin, pack));
  } catch (error) {
    logger.warn('billing', 'coach_handbooks_failed', { code: errorCode(error) });
    return new Map();
  }
}

/** Handbooks per package hash, for a chat turn: the files of a published revision never change, so one read serves every turn of a few minutes. */
const CHAT_CACHE_MS = 10 * 60_000;
/** An empty or failed read is remembered briefly, so a down or unpublished package costs one attempt a minute, not two RPCs per chat turn. */
const CHAT_EMPTY_MS = 60_000;
/** A hung read must not hold a chat turn back: past this the turn goes on without lines (the read still finishes and fills the cache). */
const CHAT_READ_TIMEOUT_MS = 2_000;
type ChatEntry = { at: number; handbooks: Map<string, Handbook> };
const chatCache = new Map<string, ChatEntry>();
const chatReads = new Map<string, Promise<ChatEntry>>();
/**
 * loadCoachHandbooks for a chat turn (read before turn_open, never inside it). Unlike the weekly review, which reads every time, a revoked
 * or unpublished package keeps being used for up to CHAT_CACHE_MS here. Never throws; concurrent turns share one read.
 */
export async function loadChatHandbooks(admin: Pick<SupabaseClient, 'rpc'>, env: Record<string, string | undefined>, now = Date.now()) {
  const pack = readHandbookPackage(env);
  if (!pack) return new Map<string, Handbook>();
  const hit = chatCache.get(pack.packageHash);
  if (hit && now - hit.at < (hit.handbooks.size ? CHAT_CACHE_MS : CHAT_EMPTY_MS)) return hit.handbooks;
  const key = pack.packageHash;
  let read = chatReads.get(key);
  if (!read) {
    // A read that outlives the timeout is dropped from the single flight (below), so a later read can start; a late answer only
    // fills the cache when no newer read has been started since.
    const mine = read = loadCoachHandbooks(admin, env).then(handbooks => {
      const entry = { at: now, handbooks };
      if (chatReads.get(key) === mine || !chatReads.has(key)) chatCache.set(key, entry);
      return entry;
    }).finally(() => { if (chatReads.get(key) === mine) chatReads.delete(key); });
    chatReads.set(key, mine);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CHAT_READ_TIMEOUT_MS); });
  const done = await Promise.race([read, late]);
  clearTimeout(timer);
  if (done) return done.handbooks;
  // Timed out: stop waiting for this read, and remember "no lines" for a minute so the next turns neither wait nor pile up reads.
  if (chatReads.get(key) === read) chatReads.delete(key);
  chatCache.set(key, { at: now, handbooks: new Map() });
  logger.warn('billing', 'coach_chat_handbooks_slow', {});
  return new Map<string, Handbook>();
}
export const clearChatHandbookCache = () => { chatCache.clear(); chatReads.clear(); };
