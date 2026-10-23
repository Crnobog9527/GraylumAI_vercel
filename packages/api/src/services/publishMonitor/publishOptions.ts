/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { listConnections } from './foundation';
import { PublishError } from './publish';

/**
 * PUBLISH-MONITOR PR-5 front end (plan §9 item 8): one-click publishing opens platform by platform, only after that
 * platform passed its real publishing check. The admin-written list `publish_monitor_publish_platforms` (an array of
 * connection platform names) is the only source; a missing or malformed value opens no platform. The server refuses
 * other platforms; hiding them in the page is only the visible half.
 */
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
export const PUBLISH_PLATFORMS_SETTING = 'publish_monitor_publish_platforms';
const PRICE_SETTING = 'publish_monitor_publish_price';
const MAX_TARGETS = 9;

const platforms = z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/)).max(32);
const decimal = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/);
const price = z.object({ usdPerTarget: decimal, multiplier: decimal, creditsPerUsd: decimal }).passthrough();

async function setting(db: Pick<SupabaseClient, 'from'>, key: string): Promise<unknown> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new PublishError('PUBLISH_MONITOR_UNAVAILABLE');
  return data?.value ?? null;
}

export async function openPublishPlatforms(db: Pick<SupabaseClient, 'from'>): Promise<string[]> {
  const parsed = platforms.safeParse(await setting(db, PUBLISH_PLATFORMS_SETTING));
  return parsed.success ? [...new Set(parsed.data)] : [];
}

/** An exact decimal as numerator / denominator, so 0.01 x 6 x 100 is 6, never 6.000000000000001. */
function exact(value: string): [bigint, bigint] {
  const [whole, fraction = ''] = value.split('.');
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}

/**
 * The most a publish to n targets can hold, for n = 1..9 (index n - 1): the same whole-job rounding as the claim
 * (ceil(n x USD x multiplier x credits per USD)); only successful platforms are charged in the end.
 */
export function holdCreditsByTargets(raw: unknown): number[] | null {
  const parsed = price.safeParse(raw);
  if (!parsed.success) return null;
  const parts = [parsed.data.usdPerTarget, parsed.data.multiplier, parsed.data.creditsPerUsd].map(exact);
  const num = parts.reduce((acc, [n]) => acc * n, 1n);
  const den = parts.reduce((acc, [, d]) => acc * d, 1n);
  return Array.from({ length: MAX_TARGETS }, (_, i) => Number((BigInt(i + 1) * num + den - 1n) / den));
}

export async function readPublishOptions(db: Pick<SupabaseClient, 'from'>) {
  const [open, rawPrice] = await Promise.all([openPublishPlatforms(db), setting(db, PRICE_SETTING)]);
  return { platforms: open, holdCreditsByTargets: holdCreditsByTargets(rawPrice) };
}

/**
 * The connection ids and state of this user's job under this idempotency key, or null when there is none. A job under
 * the key is a replay, which is answered from the database and is never gated again.
 */
export async function publishKeyJob(db: Pick<SupabaseClient, 'from'>, profileId: string,
  key: string): Promise<{ targets: string[]; state: string } | null> {
  const { data, error } = await db.from('social_publish_jobs').select('targets,state').eq('actor_id', profileId)
    .eq('idempotency_key', key).maybeSingle();
  if (error) throw new PublishError('PUBLISH_MONITOR_UNAVAILABLE');
  if (!data) return null;
  const targets = z.array(z.object({ connectionId: z.string() }).passthrough()).safeParse(data.targets);
  return { targets: targets.success ? targets.data.map(t => t.connectionId) : [], state: String(data.state) };
}

/**
 * An upload for a replay may skip the open-platform and connection checks only for the exact targets the existing job
 * saved, and only while that job still has an open result to settle; any other id gets the normal checks.
 */
export async function assertUploadAllowed(db: Db, profileId: string, connectionIds: string[], key?: string): Promise<void> {
  const saved = key ? (await publishKeyJob(db, profileId, key))?.targets ?? null : null;
  const same = saved !== null && saved.length === connectionIds.length && new Set(connectionIds).size === saved.length
    && connectionIds.every(id => saved.includes(id));
  if (!same) await assertPublishPlatformsOpen(db, profileId, connectionIds);
}

/**
 * Every target must be one of the user's own connected, publish-authorized Post for Me accounts on an open platform,
 * one per platform. This runs before an upload slot is issued (the claim only comes after the upload), so an unknown
 * or unfit id never costs a provider storage slot.
 */
export async function assertPublishPlatformsOpen(db: Db, profileId: string, connectionIds: string[]): Promise<void> {
  const open = new Set(await openPublishPlatforms(db));
  if (open.size === 0) throw new PublishError('PUBLISH_MONITOR_PLATFORM_NOT_OPEN');
  const mine = new Map((await listConnections(db, profileId)).map(c => [c.id, c]));
  const seen = new Set<string>();
  for (const id of connectionIds) {
    const connection = mine.get(id);
    if (!connection || connection.role !== 'own' || connection.source !== 'postforme' || connection.status !== 'connected'
      || !connection.consentPublish || seen.has(connection.platform)) throw new PublishError('PUBLISH_MONITOR_TARGET_INVALID');
    seen.add(connection.platform);
    if (!open.has(connection.platform)) throw new PublishError('PUBLISH_MONITOR_PLATFORM_NOT_OPEN');
  }
}
