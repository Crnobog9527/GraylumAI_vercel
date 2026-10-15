/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../../bill2/service';
import { throwIfContentErased } from '../../accountErasure/content';
import { canonicalAccount, type CanonicalAccount } from '../tools/accountLinks';
import type { AuthorizationScope, AuthorizationStore } from '../tools/authorize';
import type { SocialPlatform } from '../vendors/types';
import type { EvidencePort } from './subcall';

export interface RuntimeResearchScope extends AuthorizationScope { executionId: string }
export interface SelectionCard {
  cardId: string; kind: 'keywords' | 'candidates'; options: Record<string, unknown>[];
  minSelect: number; maxSelect: number;
}
export interface CardPayload {
  kind: 'keywords' | 'candidates'; options: Record<string, unknown>[];
  discoveryId?: string; minSelect?: number; followUp?: boolean;
}
export interface CardConfirmation {
  cardId: string; confirmationId: string; kind: 'keywords' | 'candidates'; items: unknown[];
}
export interface DiscoveryRecord {
  discoveryId: string; keywords: string[]; platforms: SocialPlatform[];
  cursor: Record<string, unknown>; state: 'running' | 'completed';
}
export type FetchState = 'prepared' | 'in_progress' | 'succeeded' | 'unknown' | 'failed' | 'failed_charged';
export type FetchClaim = { claimed: true; fetchId: string; attempt: string }
  | { claimed: false; fetchId: string; state: FetchState; evidence: Record<string, unknown> | null };
export interface RuntimePlan {
  executionId: string; discoveryId: string | null; budgetUnits: number; cancelled: boolean;
  operations: { operationId: string; identityHash: string; maxQuoteUnits: number }[];
}
export interface RuntimeOperation {
  executionId?: string; identityHash?: string; state: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  result?: Record<string, unknown> | null; resultAccess?: 'restricted';
}

/** Construct from authenticated host identity only. The migration owns every state transition. */
export function databaseRuntimeResearchStore(deps: {
  admin: BillingRpc; db: SupabaseClient; scope: RuntimeResearchScope;
}) {
  const { admin, scope } = deps;
  const a = scope.userId;
  const s = scope.sessionId;
  const e = scope.executionId;
  const matches = (other: AuthorizationScope) => other.userId === a && other.sessionId === s;
  const check = (error: unknown) => {
    throwIfContentErased(error);
    if (error) throw new Error('RESEARCH_STATE_UNAVAILABLE');
  };
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(name, args);
    check(error);
    return data as T;
  }
  function read<T>(kind: string, id: string): Promise<T> {
    return rpc<T>('research_runtime_read', { a, s, e, p_kind: kind, p_id: id });
  }
  async function confirmation(id: string) {
    return rpc<{ kind: string; items: unknown[] } | null>('research_confirmation_read', { a, s, p_confirmation: id });
  }
  function accounts(items: unknown[]): CanonicalAccount[] | null {
    const result: CanonicalAccount[] = [];
    for (const value of items) {
      if (!value || typeof value !== 'object' || !('platform' in value) || !('account' in value)
        || typeof value.platform !== 'string' || typeof value.account !== 'string') return null;
      const platform = value.platform as SocialPlatform;
      const account = canonicalAccount(platform, value.account);
      if (!account) return null;
      result.push({ platform, account });
    }
    return result;
  }
  const authorization: AuthorizationStore = {
    async keywordConfirmation(other, id) {
      if (!matches(other)) return null;
      const record = await confirmation(id);
      return record?.kind === 'keywords' && record.items.every(item => typeof item === 'string')
        ? { keywords: record.items as string[] } : null;
    },
    async candidateConfirmation(other, id) {
      if (!matches(other)) return null;
      const record = await confirmation(id);
      return record?.kind === 'candidates' ? accounts(record.items) : null;
    },
    async userMessage(other, id) {
      if (!matches(other)) return null;
      return rpc<string | null>('research_user_message', { a, s, e: id });
    },
    async refreshGrant(other, id) {
      if (!matches(other)) return null;
      const grant = await read<(CanonicalAccount & { used: boolean }) | null>('refresh', id);
      if (!grant) return null;
      const parsed = accounts([grant]);
      return parsed ? { ...parsed[0], used: grant.used } : null;
    },
  };
  function transition<T>(action: string, id: string, payload: Record<string, unknown> = {}) {
    return rpc<T>('research_transition', {
      p_action: action, p_plan_id: id, p_actor_id: a, p_operation_id: id, p_payload: payload,
    });
  }
  function evidence(discoveryId?: string): EvidencePort {
    return {
      async open(id, identityHash, quoteUnits) {
        if (!Number.isSafeInteger(quoteUnits) || quoteUnits < 0 || quoteUnits > 1_000_000_000) {
          throw new Error('RESEARCH_QUOTE_INVALID');
        }
        // One plan per supplier subcall, with the same id: no in-memory map needed during recovery.
        await rpc('research_runtime_plan_create', { a, p_plan: id, s, e, p_discovery: discoveryId ?? null,
          p_payload: { budgetUnits: Math.max(1, quoteUnits), maxOperations: 1,
            operations: [{ operationId: id, identityHash, maxQuoteUnits: quoteUnits }] } });
        const reserved = await transition<{ claimed: boolean; token?: string }>('reserve', id, { identityHash, quoteUnits });
        if (!reserved.claimed || !reserved.token) return null;
        const dispatched = await transition<{ dispatch: boolean }>('dispatch', id, { token: reserved.token });
        return dispatched.dispatch ? { token: reserved.token } : null;
      },
      async finish(id, token, state, result) {
        // quoteUnits are micro-USD; result.cost.actual stays USD (research_transition multiplies by 1e6).
        await transition('finish', id, { token, state, result });
      },
      async link(id, callId) {
        await rpc('research_runtime_link', { a, p_plan: id, s, e, p_discovery: discoveryId ?? null,
          p_operation: id, p_call: callId });
      },
    };
  }
  async function readOperation(id: string): Promise<RuntimeOperation | null> {
    const operation = await read<RuntimeOperation | null>('operation', id);
    if (!operation?.result) return operation;
    const terminal = ['succeeded', 'failed', 'unknown'].includes(operation.state);
    if (!Object.hasOwn(operation.result, 'billing')) {
      if (terminal && (Object.hasOwn(operation.result, 'outcome') || Object.hasOwn(operation.result, 'items'))) {
        throw new Error('RESEARCH_STATE_UNAVAILABLE');
      }
      return operation;
    }
    if (operation.resultAccess === 'restricted' || !terminal) {
      throw new Error('RESEARCH_STATE_UNAVAILABLE');
    }
    const saved = z.object({ runId: z.string().uuid(), callId: z.string().uuid(),
      receipt: z.record(z.string(), z.unknown()),
    }).safeParse(operation.result.billing);
    if (!saved.success) throw new Error('RESEARCH_STATE_UNAVAILABLE');
    const plan = await read<RuntimePlan | null>('plan', id);
    if (!plan?.executionId) throw new Error('RESEARCH_SCOPE_DENIED');
    // Validate the original answer, request hash and call owner before recording its saved receipt.
    // Never bind a recovered operation to the current answer or its billing run.
    await rpc('research_runtime_link', { a, p_plan: id, s, e: plan.executionId,
      p_discovery: plan.discoveryId, p_operation: id, p_call: saved.data.callId });
    const recorded = await rpc<unknown>('bill2_record', { p_actor_id: a, p_run_id: saved.data.runId,
      p_call_id: saved.data.callId, p_evidence: saved.data.receipt });
    const view = z.object({ accountClosed: z.boolean().optional(), contentDeleted: z.boolean().optional() })
      .safeParse(recorded);
    if (!view.success) throw new Error('RESEARCH_STATE_UNAVAILABLE');
    if (view.data.accountClosed || view.data.contentDeleted) {
      throwIfContentErased({ code: '42501', message: 'CONTENT_ERASED' });
    }
    return operation;
  }
  return {
    authorization, evidence,
    async cancelUnsentPlan(id: string) {
      if (!await read<RuntimePlan | null>('plan', id)) throw new Error('RESEARCH_SCOPE_DENIED');
      await transition('cancel', id);
    },
    readOperation,
    readPlan: (id: string) => read<RuntimePlan | null>('plan', id),
    createCard: (id: string, payload: CardPayload) => rpc<SelectionCard>('research_card_create', { a, p_card: id, s, e, p: payload }),
    async confirmCard(id: string, payload: { selected: string[]; edits?: Record<string, string>; additions?: string[] }) {
      // confirm RPC checks actor ownership, while this fence also enforces the requested session.
      const card = await read<SelectionCard | null>('card', id);
      if (!card) throw new Error('RESEARCH_SCOPE_DENIED');
      return rpc<CardConfirmation>('research_card_confirm', { a, p_card: id, p: payload });
    },
    discoveryStart: (confirmationId: string, platforms: SocialPlatform[]) => rpc<DiscoveryRecord>('research_discovery_start', {
      a, s, e, p_confirmation: confirmationId, p_platforms: platforms,
    }),
    discoveryRead: (id: string) => read<DiscoveryRecord | null>('discovery', id),
    discoverySave: (id: string, cursor: Record<string, unknown>, state: DiscoveryRecord['state']) =>
      rpc<DiscoveryRecord>('research_discovery_save', { a, s, p_discovery: id, p_cursor: cursor, p_state: state }),
    async selectedAccounts(discoveryId: string): Promise<CanonicalAccount[]> {
      const selected = accounts(await read<unknown[]>('selected', discoveryId));
      if (!selected) throw new Error('RESEARCH_STATE_UNAVAILABLE');
      return selected;
    },
    fetchClaim: (platform: SocialPlatform, account: string, refreshId?: string) => rpc<FetchClaim>('research_account_fetch_claim', {
      a, s, e, p_platform: platform, p_account: account, p_refresh: refreshId ?? null,
    }),
    fetchDispatch: (fetchId: string, attempt: string) => rpc<boolean>('research_account_fetch_dispatch', {
      a, p_fetch: fetchId, p_attempt: attempt,
    }),
    async fetchFinish(fetchId: string, attempt: string, state: Exclude<FetchState, 'prepared' | 'in_progress'>,
      evidence: Record<string, unknown> | null) {
      await rpc('research_account_fetch_finish', { a, p_fetch: fetchId, p_attempt: attempt, p_state: state, p_evidence: evidence });
    },
    refreshCreate: (platform: SocialPlatform, account: string) => rpc<string>('research_refresh_create', {
      a, s, p_platform: platform, p_account: account,
    }),
  };
}
export type RuntimeResearchStore = ReturnType<typeof databaseRuntimeResearchStore>;
