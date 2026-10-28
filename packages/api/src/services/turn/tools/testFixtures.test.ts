/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { ResearchCallResult, ResearchVendor } from '../../research/vendors/types';
import type { CounterStore } from '../limiter';
import type { ToolCallDeps } from './types';

// Shared doubles for the V2-6 tool tests (a .test.ts file so the code-size and coverage rules treat it as test code).
export const quiet = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };

export function policy(vendor: ResearchVendor, route: string, price = '0.001', multiplier = '6'): ToolCallPolicy {
  const unit = vendor === 'tikhub' ? 'call' : vendor === 'parallel' ? 'sku_search' : 'credit';
  return { provider: vendor, account: 'research-production', model: `${vendor}:${route}`, protocol: 'research-tool-v1',
    modelId: '00000000-0000-0000-0000-000000000000', multiplier, lookupSupported: false, upperUsd: price, purposes: ['research'],
    toolPricing: { unit, currency: 'USD', price, unitsPerPrice: '1', usdPerCurrency: null, entryHash: 'a'.repeat(64),
      validUntil: '2099-01-01T00:00:00Z', maxUnitsPerCall: '1' } };
}

export function result(over: Partial<ResearchCallResult> & Pick<ResearchCallResult, 'vendor' | 'route'>): ResearchCallResult {
  return { outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
    usage: { unit: over.vendor === 'tikhub' ? 'call' : over.vendor === 'parallel' ? 'sku_search' : 'credit', units: '1' },
    items: [{ fields: { title: 'a post' }, missing: [] }], truncated: false, fetchedAt: '2026-10-28T00:00:00.000Z', ...over };
}

export const freeSlots: CounterStore = { take: async () => 1, drop: async () => undefined };

/** A database double that records every write. `begin` may answer paused/tombstoned or throw a code. */
export function ledger(over: { begin?: () => Record<string, unknown> | Error; record?: () => Record<string, unknown> } = {}) {
  const writes: Array<[string, Record<string, unknown>]> = [];
  let seq = 0;
  const db = {
    begin: vi.fn(async (a: Record<string, unknown>) => {
      const answer = over.begin?.();
      if (answer instanceof Error) throw answer;
      writes.push(['begin', a]);
      return { state: 'running', status: 'dispatched', ...quiet, ...answer };
    }),
    record: vi.fn(async (a: Record<string, unknown>) => { writes.push(['record', a]);
      return { status: a.status, creditsLow: false, ...quiet, ...over.record?.() }; }),
  } as unknown as ToolCallDeps['db'];
  const kinds = () => writes.map(([k, a]) => k + (k === 'record' ? ':' + String(a.status) : ''));
  return { writes, kinds, deps: { db, actorId: 'actor', turnId: 7, nextSeq: () => ++seq } satisfies ToolCallDeps };
}

it('fixtures load', () => { expect(policy('tikhub', 'r').model).toBe('tikhub:r'); });
