/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TurnView } from '@repo/api/src/services/turn/view';
import type { ResearchCall } from '@/components/research/research-model';
import { workItemFromResearchCall, type WorkItem } from '@/components/chat-display/agent-work-model';

/*
 * CORE-PATH-V2 V2-10 "恢复无感": a reload keeps the rows of what a reply looked up. They are read back from the receipts of its paid
 * calls (GET /api/turn `calls`), one row per subcall, as the stream showed them, each with the credits its receipt settled.
 */
const dataKinds: Record<string, ResearchCall['dataKind']> = { social_search: 'keyword_posts', social_account: 'account_profile',
  web_search: 'web_search', web_fetch: 'web_fetch' };
type Result = { outcome?: string; items?: number; costUsd?: string | null };

const askedOf = (text: string | null): Record<string, unknown> => {
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { return {}; }
};
const shown = (args: Record<string, unknown>) => [args.query, args.url, args.account,
  Array.isArray(args.keywords) ? args.keywords.join(' ') : undefined].find((value): value is string => typeof value === 'string' && Boolean(value)) ?? '';

export function workRowsOf(calls: TurnView['calls']): Map<number, WorkItem[]> {
  const rows = new Map<number, WorkItem[]>();
  for (const call of calls) {
    const args = askedOf(call.arguments), results = (call.usage as { results?: Result[] } | null)?.results ?? [];
    const platform = (typeof args.platform === 'string' ? args.platform : 'web') as ResearchCall['platform'];
    const made = results.map((result, index) => workItemFromResearchCall({ callId: `${call.turnId}:${call.seq}:${index}`,
      toolName: call.toolName ?? '', args: {}, query: shown(args), platform, dataKind: dataKinds[call.toolName ?? ''] ?? 'web_search',
      state: result.outcome === 'unknown' ? 'unknown' : ['ok', 'partial'].includes(result.outcome ?? '') ? 'succeeded' : 'failed',
      credits: result.items && result.costUsd ? String(Number(result.costUsd) * Number(call.multiplier) * Number(call.q)) : null }));
    rows.set(call.turnId, [...rows.get(call.turnId) ?? [], ...made]);
  }
  return rows;
}
