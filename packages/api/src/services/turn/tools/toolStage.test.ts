/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { toolStage } from './toolStage';

const skills = new Set(['分镜', 'Hooks']);
const COACH = 'coach_review:00000000-0000-4000-8000-000000000001';

describe('what the page is told when a tool is about to run', () => {
  it('load_skill names the Skill only when it is one of this turn\'s, by its public name', () => {
    expect(toolStage('load_skill', { name: '分镜' }, skills)).toEqual({ type: 'tool', tool: 'load_skill', label: '分镜' });
    expect(toolStage('load_skill', { name: 'not-a-skill' }, skills)).toEqual({ type: 'tool', tool: 'load_skill' });
    expect(toolStage('load_skill', {}, skills)).toEqual({ type: 'tool', tool: 'load_skill' });
  });

  it('each research tool is "research"; read_source is the library, or the coach review for its entry', () => {
    for (const name of ['social_search', 'social_account', 'web_search', 'web_fetch'])
      expect(toolStage(name, { query: 'x' }, skills)).toEqual({ type: 'tool', tool: 'research' });
    expect(toolStage('read_source', { query: 'doc-1' }, skills)).toEqual({ type: 'tool', tool: 'read_source' });
    expect(toolStage('read_source', {}, skills)).toEqual({ type: 'tool', tool: 'read_source' });
    expect(toolStage('read_source', { query: 'coach_review' }, skills)).toEqual({ type: 'tool', tool: 'coach_review' });
    expect(toolStage('read_source', { query: COACH }, skills)).toEqual({ type: 'tool', tool: 'coach_review' });
    // Only the exact entry id counts: a query that merely starts with it is a library read.
    expect(toolStage('read_source', { query: 'coach_review please' }, skills)).toEqual({ type: 'tool', tool: 'read_source' });
  });

  it('any other tool is "other"', () => {
    expect(toolStage('read_skill_file', { path: 'a.md' }, skills)).toEqual({ type: 'tool', tool: 'other' });
  });

  it('never carries an argument, a query or a result: the event holds the kind and at most a public Skill name', () => {
    const event = toolStage('web_search', { query: 'SECRET-QUERY', url: 'https://x.invalid/SECRET' }, skills);
    expect(JSON.stringify(event)).not.toContain('SECRET');
    expect(Object.keys(toolStage('load_skill', { name: '分镜', extra: 'SECRET' }, skills)).sort()).toEqual(['label', 'tool', 'type']);
  });
});
