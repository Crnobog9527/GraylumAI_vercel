/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CanonicalAccount } from '../tools/accountLinks';
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
/** 0320 `research_benchmark_shortfall_view`. */
export interface ShortfallCard {
  cardId: string; required: number; offeredQualified: number; offeredRounds: number;
  choice: 'continue' | 'generate' | null; confirmationId: string | null;
}
export interface DiscoveryRecord {
  discoveryId: string; keywords: string[]; platforms: SocialPlatform[];
  cursor: Record<string, unknown>; state: 'running' | 'completed';
}
export type FetchState = 'prepared' | 'in_progress' | 'succeeded' | 'unknown' | 'failed' | 'failed_charged';
/** resumed: this answer's own attempt, left in progress by a balance pause (BILL-PAYG); its finished subcalls are reused. */
export type FetchClaim = { claimed: true; fetchId: string; attempt: string; resumed?: true }
  | { claimed: false; fetchId: string; state: FetchState; evidence: Record<string, unknown> | null };
export interface RuntimePlan {
  executionId: string; discoveryId: string | null; budgetUnits: number; cancelled: boolean;
  operations: { operationId: string; identityHash: string; maxQuoteUnits: number }[];
}
export interface RuntimeOperation {
  executionId?: string; identityHash?: string; state: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  result?: Record<string, unknown> | null; resultAccess?: 'restricted';
}

/** The billing run of a subcall settled on turn_calls (CORE-PATH-V2): it has no BILL2 receipt to record again. */
export const TURN_BILLING_RUN = '00000000-0000-4000-8000-000000000000';

/** What the research tools need from a store: the turn core's in-memory one (turn/tools/benchmarkStore) or the old runtime's database one. */
export interface RuntimeResearchStore {
  authorization: AuthorizationStore;
  evidence: (discoveryId?: string) => EvidencePort;
  cancelUnsentPlan: (id: string) => Promise<void>;
  readOperation: (id: string) => Promise<RuntimeOperation | null>;
  readPlan: (id: string) => Promise<RuntimePlan | null>;
  readCard: (id: string) => Promise<SelectionCard | null>;
  createCard: (id: string, payload: CardPayload) => Promise<SelectionCard>;
  confirmCard: (id: string, payload: { selected: string[]; edits?: Record<string, string>; additions?: string[] }) => Promise<CardConfirmation>;
  /** BENCHMARK-SHORTFALL (0320): the session's choice card, or null when it is not due. Free; the host decides, the model only asks. */
  offerShortfall: (cardId: string) => Promise<ShortfallCard | null>;
  discoveryStart: (confirmationId: string, platforms: SocialPlatform[]) => Promise<DiscoveryRecord>;
  discoveryRead: (id: string) => Promise<DiscoveryRecord | null>;
  /** The keywords the user confirmed on this session's keyword cards (BENCHMARK-COVERAGE relevance); optional: without it no topic relevance is computed. */
  sessionKeywords?: () => Promise<string[]>;
  discoverySave: (id: string, cursor: Record<string, unknown>, state: DiscoveryRecord['state']) => Promise<DiscoveryRecord>;
  selectedAccounts: (discoveryId: string) => Promise<CanonicalAccount[]>;
  fetchClaim: (platform: SocialPlatform, account: string, refreshId?: string) => Promise<FetchClaim>;
  fetchResume: (platform: SocialPlatform, account: string, refreshId?: string) => Promise<{ fetchId: string; attempt: string } | null>;
  fetchDispatch: (fetchId: string, attempt: string) => Promise<boolean>;
  fetchFinish: (fetchId: string, attempt: string, state: Exclude<FetchState, 'prepared' | 'in_progress'>,
    evidence: Record<string, unknown> | null) => Promise<void>;
  refreshCreate: (platform: SocialPlatform, account: string) => Promise<string>;
  /** Unrounded user credits of a settled tool call of this answer; null while unsettled. */
  callCharge: (callId: string) => Promise<string | null>;
}
