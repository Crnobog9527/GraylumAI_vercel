/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { GENERAL_RESEARCH_TOOLS, POSITIONING_RESEARCH_TOOLS } from '../../research/tools/names';
import { COACH_REVIEW_ID } from './coachReview';
import type { StepEvent, StepKind, StepState } from '../sse';
import type { ToolStatus } from '../../research/tools/envelope';

/*
 * What the page is told about the tools of a reply (the reply has no text until a tool answers and the next model call starts).
 * Only the kind of tool, a Skill's public catalog name, the first words of a search and a count of results; no argument, query in
 * full or result text ever goes into it. A start and an end share one id, so the page shows one step that changes.
 */
export type StepStart = Pick<StepEvent, 'tool' | 'label' | 'detail'>;
const BRIEF_CHARS = 20;
/** The owned-source ids of the user's own post data (tools/workspace.ts). */
const OWN_DATA_QUERY = /^my_posts(?::(?:14|30|90))?$/;
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
  // The positioning page's benchmark flow (keywords, discover, more candidates, fetch) is the same "searching" as the general lookups.
  if ((GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name) || (POSITIONING_RESEARCH_TOOLS as readonly string[]).includes(name)) {
    const words = [args.query, Array.isArray(args.keywords) ? args.keywords.join(' ') : undefined, args.account]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
    // A query that is itself a link shows only its host (a link may carry a login or a token).
    const link = words && /^https?:\/\//i.test(words.trim()) ? words.trim() : typeof args.url === 'string' ? args.url : '';
    const shown = link ? host(link) : words ? brief(words) : '';
    return { tool: 'research', ...(shown ? { detail: shown } : {}) };
  }
  if (name === 'read_source') {
    // The coach review and the account's own post data (my_posts, my_posts:14|30|90) are "your data", not the library.
    return { tool: typeof args.query === 'string' && (OWN_DATA_QUERY.test(args.query) || COACH_REVIEW_ID.test(args.query)) ? 'coach_review' : 'read_source' };
  }
  // The method's own file (the mentor's references) is part of reading the method.
  if (name === 'read_skill_file') return { tool: 'load_skill' };
  return { tool: 'other' };
}

/*
 * Every answer a tool can give, put into one of three ends (the table in toolStage.test.ts holds each of them):
 *  done     the read happened (nothing new to read is still a read; an old snapshot is still a read);
 *  failed   the read did not work (the source could not answer);
 *  skipped  it was not used this reply: not available, a limit spent, no right to it, or no account connected yet.
 * Research and benchmark envelopes answer by `status`; the library and the workspace answer by `kind` (+ `status` for own posts and
 * the coach review, + `reason` for an unavailable one).
 */
const ENVELOPE_END: Record<ToolStatus, StepState> = { ok: 'done', partial: 'done', unavailable: 'failed', not_supported: 'skipped',
  not_confirmed: 'skipped', budget_exhausted: 'skipped' };
/** The own-post and coach reads' statuses: a connected account with nothing new, or only an old snapshot, still read what there is. */
const DATA_END: Record<string, StepState> = { available: 'done', stale: 'done', no_recent_posts: 'done', no_entitlement: 'skipped' };
/** An account with no brand / no connected account: nothing to read yet (the page says so in its own words). */
const NO_ACCOUNT = new Set(['no_brand', 'not_connected']);
/** An unavailable read whose reason is a limit of this reply, not a broken source. */
const LIMIT_REASONS = new Set(['read_limit', 'read_room', 'TOOL_UNAVAILABLE_THIS_TURN', 'SKILL_FILE_NOT_DECLARED']);

/** How a tool's result ended its step. A thrown error is the caller's `failed`. */
export function stepEnd(tool: StepKind, result: string): Pick<StepEvent, 'state' | 'count' | 'reason'> {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A Skill's refusal and the trimmed-tool answer are plain text.
    return /cannot be loaded|cannot be used in this reply/.test(result) ? { state: 'skipped' } : { state: 'done' };
  }
  const body = parsed as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (NO_ACCOUNT.has(status)) return { state: 'skipped', reason: 'no_brand' };
  if (LIMIT_REASONS.has(reason)) return { state: 'skipped' };
  // The library and the workspace say {kind:'unavailable'} (with or without a reason) when nothing could be read.
  const state: StepState = body.kind === 'unavailable' ? 'failed'
    : Object.hasOwn(ENVELOPE_END, status) ? ENVELOPE_END[status as ToolStatus] : Object.hasOwn(DATA_END, status) ? DATA_END[status]! : 'done';
  if (state !== 'done') return { state };
  const list = [body.items, body.hits, body.documents].find(Array.isArray) as unknown[] | undefined;
  return tool === 'research' || tool === 'read_source' ? { state, ...(list ? { count: list.length } : {}) } : { state };
}

/** The longest Skill name a saved step keeps (turn_chat_steps_apply refuses the whole list above it; a step title may be up to 160). */
export const SAVED_LABEL_CHARS = 80;
const SAVED_STEPS_BYTES = 4096;

/** The steps of a closed reply as they are kept (turn_chat_steps_apply): only what the page needs to show them again. A step still running when
 *  the reply ended did not finish, so it is kept as failed; the search words (`detail`) are not kept. */
export function savedSteps(events: Iterable<StepEvent>) {
  const first = [...events].slice(0, 16);
  const build = (names: boolean) => first.map(event => ({ id: event.id, tool: event.tool, state: event.state === 'running' ? 'failed' : event.state,
    ...(names && event.label ? { label: Array.from(event.label).slice(0, SAVED_LABEL_CHARS).join('') } : {}),
    ...(event.count !== undefined ? { count: event.count } : {}), ...(event.reason ? { reason: event.reason } : {}) }));
  // The column holds at most 4096 bytes (turn_chat_steps_apply refuses the whole list above it): names are the only long part, so drop
  // them before dropping the list.
  const kept = build(true);
  return Buffer.byteLength(JSON.stringify(kept)) > SAVED_STEPS_BYTES ? build(false) : kept;
}
