/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { topicRelevance } from '../relevance';
import type { EvidenceItem } from '../metrics';

const post = (title?: string): EvidenceItem => ({ ref: 'op#1', fields: title === undefined ? { id: 'x' } : { id: 'x', title }, missing: [] });

describe('topic relevance (BENCHMARK-COVERAGE §2.6)', () => {
  it('counts posts whose title names a confirmed keyword: all its words in any order, hashtags and case ignored', () => {
    const posts = [post('My #Hardanger embroidery tutorial'), post('Embroidery stitch, hardanger style'), post('Cat video'),
      post('苏绣入门第一课'), post()];
    expect(topicRelevance(posts, ['hardanger embroidery', '苏绣'])).toEqual({ value: 0.75, matched: 3, analyzed: 4, level: 'high' });
    expect(topicRelevance(posts, ['cross stitch'])).toMatchObject({ value: 0, level: 'low' });
    expect(topicRelevance([post('one hardanger'), ...Array(4).fill(post('other'))], ['hardanger'])).toMatchObject({ value: 0.2, level: 'medium' });
  });

  it('says nothing without keywords or titled posts (unknown, not "low")', () => {
    expect(topicRelevance([post('hardanger')], [])).toBeNull();
    expect(topicRelevance([post()], ['hardanger'])).toBeNull();
    expect(topicRelevance([post('hardanger')], ['  '])).toBeNull();
  });
});
