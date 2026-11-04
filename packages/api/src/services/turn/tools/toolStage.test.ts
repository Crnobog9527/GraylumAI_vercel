/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { SKILL_LOAD_REFUSED } from '../skills/loadSkillTool';
import { TOOL_UNAVAILABLE } from './index';
import { stepEnd, stepStart } from './toolStage';

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
    expect(stepEnd('read_source', JSON.stringify({ hits: [{}, {}] }))).toEqual({ state: 'done', count: 2 });
    expect(stepEnd('load_skill', JSON.stringify({ name: '分镜', instructions: 'x' }))).toEqual({ state: 'done' });
    expect(stepEnd('coach_review', JSON.stringify({ kind: 'review_pack' }))).toEqual({ state: 'done' });
  });
  it('a tool that did not work is failed; one that was not available this reply is skipped, which is not an error', () => {
    expect(stepEnd('research', JSON.stringify({ status: 'unavailable', reason: 'PROVIDER_FAILED', items: [] }))).toEqual({ state: 'failed' });
    expect(stepEnd('read_source', JSON.stringify({ kind: 'unavailable', reason: 'read_failed' }))).toEqual({ state: 'failed' });
    // The workspace reader's own answer when nothing could be read has no reason at all (tools/workspace.ts UNAVAILABLE).
    expect(stepEnd('read_source', JSON.stringify({ kind: 'unavailable' }))).toEqual({ state: 'failed' });
    expect(stepEnd('coach_review', JSON.stringify({ kind: 'unavailable' }))).toEqual({ state: 'failed' });
    expect(stepEnd('research', JSON.stringify({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' }))).toEqual({ state: 'skipped' });
    expect(stepEnd('research', JSON.stringify({ status: 'not_supported' }))).toEqual({ state: 'skipped' });
    expect(stepEnd('read_source', TOOL_UNAVAILABLE)).toEqual({ state: 'skipped' });
    expect(stepEnd('load_skill', SKILL_LOAD_REFUSED)).toEqual({ state: 'skipped' });
    expect(stepEnd('coach_review', JSON.stringify({ kind: 'coach_review', status: 'no_entitlement' }))).toEqual({ state: 'skipped' });
    // No brand connected yet: nothing was read, so it is not a green tick; the page says so in its own words.
    expect(stepEnd('coach_review', JSON.stringify({ kind: 'coach_review', status: 'no_brand', note: 'x' }))).toEqual({ state: 'skipped', reason: 'no_brand' });
  });
  it('the result text itself never leaves: only a state and a count', () => {
    expect(Object.keys(stepEnd('research', JSON.stringify({ status: 'ok', items: [{ fields: { text: 'SECRET' } }] }))).sort()).toEqual(['count', 'state']);
  });
});
