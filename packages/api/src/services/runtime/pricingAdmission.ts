/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import type { OpenRouterLimits } from '../bill2/openRouterPolicy';
import { readOpenRouterPricing } from '../models/openRouterCatalog';
import { readPricingSnapshot, type PricingSnapshot } from '../../shared/modelPricing';
import { deriveFrozenPrices, priceIncreases } from '../../shared/modelPriceBound';
import { readReasoningConfig } from '../../shared/modelReasoning';
import { StagingAccessError, stagingRpcFailure } from './stagingErrors';

/**
 * MODEL-PRICING-SYNC price check for real (staging window) admissions
 * (plan docs/launch/MODEL_PRICING_SYNC_PLAN.md 3.4; Owner decisions D1–D7).
 *
 * Every selected window quote must still cover the current OpenRouter price
 * snapshot of its route: each frozen price (prompt, completion, request) must
 * be at least the highest price derived from the snapshot. A rise refuses the
 * admission; a quote is never raised. Started runs, recovery and replays use
 * their frozen quote and never come here.
 */
export const PRICE_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // D1
export const PRICE_REFRESH_COOLDOWN_MS = 60_000;

type Quote = { modelId: string; model: string; providerLimits?: OpenRouterLimits };
type Row = { id: string; model_id: string; config: unknown; updated_at: string };
type Deps = { read?: (model: string) => Promise<PricingSnapshot>; now?: () => number };

/** Per server process: a model whose renewal failed is not re-read for 60 s, so an
 * OpenRouter outage does not add a 15 s wait to every request (plan 3.4). */
const failedAt = new Map<string, number>();
export function resetPriceRefreshCooldown() { failedAt.clear(); }

const ROW_COLUMNS = 'id,model_id,config,updated_at';
const isStale = (snapshot: PricingSnapshot, now: number) => now - Date.parse(snapshot.fetchedAt) > PRICE_SNAPSHOT_MAX_AGE_MS;

function log(row: Row, outcome: string, extra: Record<string, unknown> = {}) {
  logger.info('api', 'model_price_snapshot_changed', { trigger: 'admission', modelId: row.id, model: row.model_id, outcome, ...extra });
}

/**
 * Renews one stale snapshot (D4). The write is conditional on the row version
 * read before the network call and merges only `config.pricing`. When another
 * writer won, the row is read again: a fresh stored snapshot is used as is;
 * otherwise this admission compares against the snapshot it just read, without
 * writing it. Returns the row the checks must run against.
 */
async function renew(admin: SupabaseClient, row: Row, previous: PricingSnapshot, deps: Required<Deps>): Promise<{ row: Row; snapshot: PricingSnapshot }> {
  const now = deps.now();
  if (now - (failedAt.get(row.id) ?? -Infinity) < PRICE_REFRESH_COOLDOWN_MS) throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_STALE');
  let fresh: PricingSnapshot;
  try {
    fresh = await deps.read(row.model_id);
  } catch {
    failedAt.set(row.id, now);
    log(row, 'read_failed', { previousHash: previous.pricingHash });
    throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_STALE');
  }
  failedAt.delete(row.id);
  const base = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config as Record<string, unknown> : {};
  const written = await admin.from('ai_models').update({ config: { ...base, pricing: fresh }, updated_at: new Date(now).toISOString() })
    .eq('id', row.id).eq('updated_at', row.updated_at).select('id');
  const changed = previous.pricingHash !== fresh.pricingHash;
  if (!written.error && Array.isArray(written.data) && written.data.length === 1) {
    log(row, 'written', { previousHash: previous.pricingHash, pricingHash: fresh.pricingHash, changed });
    return { row: { ...row, config: { ...base, pricing: fresh } }, snapshot: fresh };
  }
  const latest = await admin.from('ai_models').select(ROW_COLUMNS).eq('id', row.id).maybeSingle();
  if (latest.error) stagingRpcFailure(latest.error);
  if (!latest.data) throw new StagingAccessError('RUNTIME_STAGING_MODEL_DENIED');
  const current = latest.data as Row, stored = readPricingSnapshot(current.config);
  const useStored = Boolean(stored && !isStale(stored, now));
  log(current, written.error ? 'write_failed' : 'write_conflict', {
    previousHash: previous.pricingHash, pricingHash: fresh.pricingHash, changed, used: useStored ? 'stored' : 'fresh_unwritten',
  });
  return { row: current, snapshot: useStored ? stored! : fresh };
}

/** The checks of plan 3.4 step 1 and 3, against the row the snapshot belongs to. */
function check(row: Row, snapshot: PricingSnapshot, quote: Quote) {
  const limits = quote.providerLimits;
  const catalog = readReasoningConfig(row.config).catalog;
  // The price route is the window quote's providerSlug, not reasoning.route (that one is checked only for
  // mentor and organizer calls by admitReasoning). The route must exist in both catalog and price snapshot.
  const tag = limits?.providerSlug;
  const endpoint = snapshot.endpoints.find(item => item.tag === tag);
  if (!limits || snapshot.model !== row.model_id || quote.model !== row.model_id || !catalog || catalog.model !== row.model_id
    || !catalog.endpoints.some(item => item.tag === tag) || !endpoint) throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_MISSING');
  const derived = deriveFrozenPrices(row.model_id, endpoint, limits.contextTokens);
  if (derived === 'UNKNOWN_PRICE_FIELD') throw new StagingAccessError('RUNTIME_PRICE_UNKNOWN_FIELD'); // D5
  if (derived === 'NOT_ADMISSIBLE') throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_MISSING');
  const increases = priceIncreases(limits, derived);
  if (increases.length) {
    logger.warn('api', 'model_price_increased', { modelId: row.id, model: row.model_id, route: tag, pricingHash: snapshot.pricingHash, increases });
    throw new StagingAccessError('RUNTIME_PRICE_INCREASED');
  }
}

/**
 * Checks every selected window quote. Stale snapshots of all selected models
 * (primary, attached organizer and every auto candidate) are renewed in
 * parallel, so one admission waits at most about one catalog timeout (15 s).
 * Any model failing a check refuses the whole admission, including one auto
 * candidate: the frozen run reserves the highest quote of all candidates.
 */
export async function admitPricing(admin: SupabaseClient, quotes: readonly Quote[], deps: Deps = {}): Promise<void> {
  const resolved: Required<Deps> = { read: deps.read ?? (model => readOpenRouterPricing(model)), now: deps.now ?? Date.now };
  const ids = [...new Set(quotes.map(quote => quote.modelId))];
  const rows = await admin.from('ai_models').select(ROW_COLUMNS).in('id', ids);
  if (rows.error) stagingRpcFailure(rows.error);
  const byId = new Map(((rows.data ?? []) as Row[]).map(row => [row.id, row]));
  const now = resolved.now();
  const states = await Promise.all(ids.map(async id => {
    const row = byId.get(id);
    if (!row) throw new StagingAccessError('RUNTIME_STAGING_MODEL_DENIED');
    const snapshot = readPricingSnapshot(row.config);
    if (!snapshot) throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_MISSING');
    return isStale(snapshot, now) ? renew(admin, row, snapshot, resolved) : { row, snapshot };
  }));
  const state = new Map(ids.map((id, index) => [id, states[index]!]));
  for (const quote of quotes) {
    const { row, snapshot } = state.get(quote.modelId)!;
    check(row, snapshot, quote);
  }
}
