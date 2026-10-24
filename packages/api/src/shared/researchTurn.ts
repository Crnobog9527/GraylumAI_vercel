/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-3b/RT-5 transport contract: research events of a positioning mentor turn on its Agent turn stream (PR-3).
import type { SocialKind, SocialPlatform } from '../services/research/vendors/types';
export interface ResearchCandidateOption {
  id: string; platform: SocialPlatform; account: string; evidenceRef: string; label?: string; selectable: boolean;
}
export type ResearchSelectionCard = { cardId: string; minSelect: number; maxSelect: number } & (
  | { kind: 'keywords'; options: { id: string; text: string }[] }
  | { kind: 'candidates'; options: ResearchCandidateOption[]; followUp?: boolean }
);
export type ResearchTurnEvent =
  | { type: 'research_card'; card: ResearchSelectionCard }
  /**
   * BENCHMARK-COVERAGE (Owner 2026-10-23, 3 A): this reply's lookups ran out while a benchmark discovery round was still
   * searching. Host-sent, never model-written: the page may send the continuation on the user's behalf.
   */
  | { type: 'research_continue'; discoveryId: string }
  | { type: 'research_call'; callId: string; toolName: string; args: Record<string, unknown>;
      query: string; platform: SocialPlatform | 'web'; dataKind: SocialKind | 'web_search' | 'web_fetch';
      state: 'running' | 'succeeded' | 'failed' | 'unknown'; evidenceId?: string;
      /** The user's unrounded settled credits for this subcall (finished, sent calls only); null when not readable yet. */
      credits?: string | null };
