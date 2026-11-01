/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { planItem } from '@repo/api/src/shared/opcRequests';
import type { z } from 'zod';
import { consentedTopicIds } from './adoption-consent';

export type PlanItem = z.infer<typeof planItem>;

/** The last JSON array the Agent offered as the first-week plan, if any. */
export function parseCandidate(text: string | null | undefined): PlanItem[] | null {
  if (!text) return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/g)].map(
    (m) => m[1],
  );
  const trimmed = text.trim();
  const bodies = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? [...blocks, trimmed]
    : blocks;
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(bodies[i]);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 28) continue;
      const items = parsed.map((raw) => {
        const item = raw as Record<string, unknown>;
        const value = (key: string) =>
          typeof item?.[key] === 'string' ? (item[key] as string).trim() : '';
        const candidate = {
          id: value('id'),
          platform: value('platform'),
          account: value('account'),
          title: value('title'),
          brief: value('brief'),
          day: value('day'),
          ...(value('contentType')?{contentType:planItem.shape.contentType.parse(value('contentType'))} : {}),
        };
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id) ||
          !/^[a-z0-9_-]{1,32}$/.test(candidate.platform) ||
          !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(candidate.account) ||
          !candidate.title || candidate.title.length > 160 ||
          !candidate.brief || candidate.brief.length > 2000 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(candidate.day)
        )
          throw new Error('invalid item');
        return candidate;
      });
      return items;
    } catch {
      /* not this block */
    }
  }
  return null;
}

export function parseAdoption(text: string | null | undefined): string[] | null {
  if (!text) return null;
  for (const match of [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].reverse()) {
    try {
      const value = JSON.parse(match[1]) as { action?: unknown; itemIds?: unknown };
      if (value.action === 'adopt' && Array.isArray(value.itemIds) && value.itemIds.length > 0
        && value.itemIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) return [...new Set(value.itemIds as string[])];
    } catch { /* not an adoption block */ }
  }
  return null;
}

/** Whether this browser kept the candidate the user saw when they sent this message, as the adoption needs. */
export function adoptionContextHeld(sessionId: string, executionId: string, candidate: unknown): boolean {
  try {
    const frozen = JSON.parse(localStorage.getItem('opc-topic-adoption-context:' + sessionId + ':' + executionId) ?? 'null') as { body?: unknown } | null;
    return Boolean(frozen) && JSON.stringify(frozen?.body) === JSON.stringify(candidate);
  } catch { return false; }
}

/**
 * What the page says when the last reply carries an adoption the page did not carry out: the reply may read as done, and nothing else
 * would tell the user that nothing was adopted. Null when there is nothing to say (no such reply, or its items are adopted).
 * canCarryOut: this browser holds the candidate the user saw when they sent it; the page acts only then.
 */
export function topicAdoptionNotice(reply: { input: string | null; body: string | null } | undefined,
  candidate: readonly { id: string; title: string }[] | null, adopted: ReadonlySet<string>, canCarryOut: boolean): string | null {
  const ids = parseAdoption(reply?.body);
  if (!reply || !ids || ids.every(id => adopted.has(id))) return null;
  if (!candidate) return '这次没有采用：上一条选题的格式不完整，没能保存成候选。请让教练重新给出选题。';
  const consented = consentedTopicIds(reply.input, candidate.map(item => item.id), candidate.map(item => item.title));
  if (canCarryOut && consented?.length === ids.length && consented.every(id => ids.includes(id))) return null;
  return '这次没有采用：系统没能确认你要采用哪一条。请在选题卡片上点采用，或直接发送“采用第一条”。';
}

/** The notice for the latest completed reply of the page: this browser's saved candidate decides whether the page could act on it. */
type Reply = { executionId: string; input: string | null; body: string | null; primaryBody: string | null };
export function lastReplyAdoptionNotice(sessionId: string, reply: Reply | undefined,
  candidate: readonly { id: string; title: string }[] | null, adopted: ReadonlySet<string>): string | null {
  if (!reply) return null;
  return topicAdoptionNotice({ input: reply.input, body: reply.body ?? reply.primaryBody }, candidate, adopted,
    adoptionContextHeld(sessionId, reply.executionId, candidate));
}
