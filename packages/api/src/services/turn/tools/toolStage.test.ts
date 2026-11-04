/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { SKILL_LOAD_REFUSED } from '../skills/loadSkillTool';
import { TOOL_UNAVAILABLE } from './index';
import { TOOL_STATUSES } from '../../research/tools/envelope';
import type { StepKind } from '../sse';
import { SKILL_FILE_UNAVAILABLE } from './skills';
import { savedSteps, stepEnd, stepStart } from './toolStage';

const skills = new Set(['分镜', 'Hooks']);
const COACH = 'coach_review:00000000-0000-4000-8000-000000000001';

describe('what the page is told when a tool starts', () => {
  it('load_skill names the Skill only when it is one of this turn\'s, by its public name', () => {
    expect(stepStart('load_skill', { name: '分镜' }, skills)).toEqual({ tool: 'load_skill', label: '分镜' });
    expect(stepStart('load_skill', { name: 'not-a-skill' }, skills)).toEqual({ tool: 'load_skill' });
    expect(stepStart('load_skill', {}, skills)).toEqual({ tool: 'load_skill' });
  });

  it('each research tool is "research" with the first ~20 characters of what it looks for, or a page\'s host', () => {
    for (const name of ['social_search', 'social_account', 'web_search', 'web_fetch']) expect(stepStart(name, {}, skills)).toEqual({ tool: 'research' });
    expect(stepStart('web_search', { query: '早起做自媒体的人怎么坚持每天发内容并且不断更' }, skills))
      .toEqual({ tool: 'research', detail: '早起做自媒体的人怎么坚持每天发内容并且不…' });
    expect(stepStart('web_search', { query: '  早起   口播  ' }, skills)).toEqual({ tool: 'research', detail: '早起 口播' });
    expect(stepStart('social_search', { keywords: ['早起', '口播'] }, skills)).toEqual({ tool: 'research', detail: '早起 口播' });
    expect(stepStart('web_fetch', { url: 'https://example.com/a/b?token=SECRET' }, skills)).toEqual({ tool: 'research', detail: 'example.com' });
    expect(stepStart('web_search', { query: 'https://user:pass@example.com/x' }, skills)).toEqual({ tool: 'research', detail: 'example.com' });
  });

  it('read_source is the library, or the coach review for its exact entry id', () => {
    expect(stepStart('read_source', { query: 'doc-1' }, skills)).toEqual({ tool: 'read_source' });
    expect(stepStart('read_source', {}, skills)).toEqual({ tool: 'read_source' });
    expect(stepStart('read_source', { query: 'coach_review' }, skills)).toEqual({ tool: 'coach_review' });
    expect(stepStart('read_source', { query: COACH }, skills)).toEqual({ tool: 'coach_review' });
    expect(stepStart('read_source', { query: 'coach_review please' }, skills)).toEqual({ tool: 'read_source' });
    // The account's own post data is "your data" too, in every window the workspace reader accepts.
    for (const query of ['my_posts', 'my_posts:14', 'my_posts:30', 'my_posts:90']) expect(stepStart('read_source', { query }, skills)).toEqual({ tool: 'coach_review' });
    expect(stepStart('read_source', { query: 'my_posts:7' }, skills)).toEqual({ tool: 'read_source' });
    expect(stepStart('read_source', { query: 'my_posts:30 extra' }, skills)).toEqual({ tool: 'read_source' });
    expect(stepStart('read_skill_file', { path: 'a.md' }, skills)).toEqual({ tool: 'other' });
  });

  it('never carries more than the kind, a Skill name, a short detail: no whole query, URL path or other argument', () => {
    const start = stepStart('web_fetch', { url: 'https://example.com/SECRET-PATH?q=SECRET', query: 'x'.repeat(500) }, skills);
    expect(JSON.stringify(start)).not.toContain('SECRET');
    const long = stepStart('web_search', { query: 'SECRET'.repeat(40) }, skills);
    expect(Array.from(long.detail ?? '').length).toBeLessThanOrEqual(21);
  });
});

describe('how a tool\'s result ends its step', () => {
  it('a result with items is done, with how many came back', () => {
    expect(stepEnd('research', JSON.stringify({ status: 'ok', items: [{}, {}, {}] }))).toEqual({ state: 'done', count: 3 });
    expect(stepEnd('research', JSON.stringify({ status: 'partial', items: [{}] }))).toEqual({ state: 'done', count: 1 });
    expect(stepEnd('research', JSON.stringify({ status: 'ok', items: [] }))).toEqual({ state: 'done', count: 0 });
    expect(stepEnd('read_source', JSON.stringify({ kind: 'library_search', hits: [{}, {}] }))).toEqual({ state: 'done', count: 2 });
    expect(stepEnd('load_skill', JSON.stringify({ name: '分镜', instructions: 'x' }))).toEqual({ state: 'done' });
  });

  // Every answer a tool can give: where each is defined, and the end the page shows. A new status of the research envelope fails the
  // typecheck of ENVELOPE_END first; a new answer of the workspace, the coach review or the library is added here.
  const answers: Array<[string, StepKind, unknown, ReturnType<typeof stepEnd>]> = [
    // research and benchmark envelopes (research/tools/envelope.ts)
    ['research ok', 'research', { status: 'ok', items: [{}] }, { state: 'done', count: 1 }],
    ['research partial', 'research', { status: 'partial', items: [{}] }, { state: 'done', count: 1 }],
    ['research unavailable (supplier failed)', 'research', { status: 'unavailable', reason: 'PROVIDER_FAILED', items: [] }, { state: 'failed' }],
    ['research unavailable (route not frozen)', 'research', { status: 'unavailable', reason: 'ROUTE_NOT_FROZEN', items: [] }, { state: 'failed' }],
    ['research unavailable (trimmed this reply)', 'research', { status: 'unavailable', reason: 'TOOL_UNAVAILABLE_THIS_TURN', items: [] }, { state: 'skipped' }],
    ['research not_supported', 'research', { status: 'not_supported', items: [] }, { state: 'skipped' }],
    ['research not_confirmed', 'research', { status: 'not_confirmed', items: [] }, { state: 'skipped' }],
    ['research budget_exhausted', 'research', { status: 'budget_exhausted', items: [] }, { state: 'skipped' }],
    // own post data (tools/workspace.ts, agent/workspacePosts.ts)
    ['my_posts available', 'coach_review', { kind: 'my_posts', status: 'available', posts: [] }, { state: 'done' }],
    ['my_posts stale', 'coach_review', { kind: 'my_posts', status: 'stale', posts: [] }, { state: 'done' }],
    ['my_posts no_recent_posts', 'coach_review', { kind: 'my_posts', status: 'no_recent_posts', posts: [] }, { state: 'done' }],
    ['my_posts not_connected', 'coach_review', { kind: 'my_posts', status: 'not_connected', note: 'x' }, { state: 'skipped', reason: 'no_brand' }],
    ['my_posts no_entitlement', 'coach_review', { kind: 'my_posts', status: 'no_entitlement' }, { state: 'skipped' }],
    // the coach review (tools/coachReview.ts)
    ['coach_review available', 'coach_review', { kind: 'coach_review', status: 'available', review: {} }, { state: 'done' }],
    ['coach_review no_brand', 'coach_review', { kind: 'coach_review', status: 'no_brand', note: 'x' }, { state: 'skipped', reason: 'no_brand' }],
    ['coach_review no_entitlement', 'coach_review', { kind: 'coach_review', status: 'no_entitlement' }, { state: 'skipped' }],
    ['coach_brands (which brand?)', 'coach_review', { kind: 'coach_brands', brands: [] }, { state: 'done' }],
    // the library and the workspace's own sources (tools/source.ts, library_turn_read, workspace.ts)
    ['library_index', 'read_source', { kind: 'library_index', documents: [{}, {}, {}] }, { state: 'done', count: 3 }],
    ['library_directory', 'read_source', { kind: 'library_directory', documents: [] }, { state: 'done', count: 0 }],
    ['library_segment', 'read_source', { kind: 'library_segment', text: 'x' }, { state: 'done' }],
    ['unavailable, no reason (no access)', 'read_source', { kind: 'unavailable' }, { state: 'failed' }],
    ['unavailable, read_failed', 'read_source', { kind: 'unavailable', reason: 'read_failed' }, { state: 'failed' }],
    ['unavailable, unknown_query', 'read_source', { kind: 'unavailable', reason: 'unknown_query' }, { state: 'failed' }],
    ['unavailable, source_deleted', 'read_source', { kind: 'unavailable', reason: 'source_deleted' }, { state: 'failed' }],
    ['unavailable, source_changed', 'read_source', { kind: 'unavailable', reason: 'source_changed' }, { state: 'failed' }],
    ['unavailable, read_limit', 'read_source', { kind: 'unavailable', reason: 'read_limit' }, { state: 'skipped' }],
    ['unavailable, read_room', 'coach_review', { kind: 'unavailable', reason: 'read_room' }, { state: 'skipped' }],
    // the tool layer itself (tools/index.ts, skills)
    ['a trimmed tool', 'read_source', JSON.parse(TOOL_UNAVAILABLE), { state: 'skipped' }],
    ['a Skill file not declared', 'other', JSON.parse(SKILL_FILE_UNAVAILABLE), { state: 'skipped' }],
  ];
  it.each(answers)('%s', (_name, tool, body, expected) => {
    expect(stepEnd(tool, JSON.stringify(body))).toEqual(expected);
  });

  it('plain-text answers: a Skill that cannot be loaded is skipped; a loaded Skill\'s text is done', () => {
    expect(stepEnd('load_skill', SKILL_LOAD_REFUSED)).toEqual({ state: 'skipped' });
    expect(stepEnd('load_skill', 'just text')).toEqual({ state: 'done' });
    // An answer that names an unknown status, or a word of the object prototype, is a read that happened.
    expect(stepEnd('research', JSON.stringify({ status: 'constructor' }))).toEqual({ state: 'done' });
  });

  it('every status of the research envelope has an end (a new one must be put in the table)', () => {
    for (const status of TOOL_STATUSES) expect(['done', 'failed', 'skipped']).toContain(stepEnd('research', JSON.stringify({ status, items: [] })).state);
  });

  it('the result text itself never leaves: only a state, a count and a fixed reason', () => {
    expect(Object.keys(stepEnd('research', JSON.stringify({ status: 'ok', items: [{ fields: { text: 'SECRET' } }] }))).sort()).toEqual(['count', 'state']);
  });
});

describe('the steps kept after a reply closed', () => {
  it('only the kind, the end state, a Skill name, a count and a fixed reason; never the search words; a step still running is failed', () => {
    const kept = savedSteps([
      { type: 'step', id: '1', tool: 'load_skill', label: '分镜', state: 'done' },
      { type: 'step', id: '2', tool: 'research', detail: 'SECRET words', state: 'done', count: 6 },
      { type: 'step', id: '3', tool: 'coach_review', state: 'skipped', reason: 'no_brand' },
      { type: 'step', id: '4', tool: 'read_source', state: 'running' }]);
    expect(kept).toEqual([{ id: '1', tool: 'load_skill', state: 'done', label: '分镜' }, { id: '2', tool: 'research', state: 'done', count: 6 },
      { id: '3', tool: 'coach_review', state: 'skipped', reason: 'no_brand' }, { id: '4', tool: 'read_source', state: 'failed' }]);
    expect(JSON.stringify(kept)).not.toContain('SECRET');
  });
  it('keeps at most 16 steps', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({ type: 'step' as const, id: String(n), tool: 'other' as const, state: 'done' as const }));
    expect(savedSteps(many)).toHaveLength(16);
  });
});
