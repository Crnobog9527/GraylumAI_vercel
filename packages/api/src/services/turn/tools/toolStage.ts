/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { COACH_REVIEW_ID } from './coachReview';
import type { StepEvent, StepKind } from '../sse';

/*
 * What the page is told about the tools of a reply (the reply has no text until a tool answers and the next model call starts).
 * Only the kind of tool, a Skill's public catalog name, the first words of a search and a count of results; no argument, query in
 * full or result text ever goes into it. A start and an end share one id, so the page shows one step that changes.
 */
export type StepStart = Pick<StepEvent, 'tool' | 'label' | 'detail'>;
const BRIEF_CHARS = 20;
const brief = (text: string) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > BRIEF_CHARS ? chars.slice(0, BRIEF_CHARS).join('') + '…' : chars.join('');
};
const host = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };

export function stepStart(name: string, args: Record<string, unknown>, skillNames: ReadonlySet<string>): StepStart {
  if (name === 'load_skill') {
    const asked = typeof args.name === 'string' ? args.name : '';
    return skillNames.has(asked) ? { tool: 'load_skill', label: asked } : { tool: 'load_skill' };
  }
  if ((GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) {
    const words = [args.query, Array.isArray(args.keywords) ? args.keywords.join(' ') : undefined, args.account]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
    // A query that is itself a link shows only its host (a link may carry a login or a token).
    const link = words && /^https?:\/\//i.test(words.trim()) ? words.trim() : typeof args.url === 'string' ? args.url : '';
    const shown = link ? host(link) : words ? brief(words) : '';
    return { tool: 'research', ...(shown ? { detail: shown } : {}) };
  }
  if (name === 'read_source') {
    return { tool: typeof args.query === 'string' && COACH_REVIEW_ID.test(args.query) ? 'coach_review' : 'read_source' };
  }
  return { tool: 'other' };
}

/** Results that mean "not available this reply" rather than "it broke": a trimmed tool, a refused Skill, a spent limit. */
const SKIPPED = new Set(['unavailable_this_turn', 'budget_exhausted', 'not_supported', 'not_confirmed', 'no_entitlement']);
const BROKEN = new Set(['unavailable', 'failed', 'error']);

/** How a tool's result ended the step. A thrown error is the caller's `failed`. */
export function stepEnd(tool: StepKind, result: string): Pick<StepEvent, 'state' | 'count'> {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A Skill's refusal and the trimmed-tool answer are plain text.
    return /cannot be loaded|cannot be used in this reply/.test(result) ? { state: 'skipped' } : { state: 'done' };
  }
  const body = parsed as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : typeof body.kind === 'string' && typeof body.reason === 'string' ? 'unavailable' : '';
  if (body.reason === 'TOOL_UNAVAILABLE_THIS_TURN' || SKIPPED.has(status)) return { state: 'skipped' };
  if (BROKEN.has(status)) return { state: 'failed' };
  const list = [body.items, body.hits, body.documents].find(Array.isArray) as unknown[] | undefined;
  return tool === 'research' || tool === 'read_source' ? { state: 'done', ...(list ? { count: list.length } : {}) } : { state: 'done' };
}
