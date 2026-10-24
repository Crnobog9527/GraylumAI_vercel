/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { topicRelevance } from '../relevance';
import type { EvidenceItem } from '../metrics';

let n = 0;
const post = (title?: string, id = `p${n++}`): EvidenceItem => ({ ref: 'op#1', fields: title === undefined ? { id } : { id, title }, missing: [] });

describe('topic relevance (BENCHMARK-COVERAGE §2.6)', () => {
  it('counts posts whose title names a confirmed keyword: all its words in any order, hashtags and case ignored', () => {
    const posts = [post('My #Hardanger embroidery tutorial'), post('Embroidery stitch, hardanger style'), post('Cat video'),
      post('苏绣入门第一课'), post()];
    expect(topicRelevance(posts, ['hardanger embroidery', '苏绣'])).toEqual({ value: 0.75, matched: 3, analyzed: 4, level: 'high' });
    expect(topicRelevance(posts, ['cross stitch'])).toMatchObject({ value: 0, level: 'low' });
    expect(topicRelevance([post('one hardanger'), ...Array.from({ length: 4 }, () => post('other'))], ['hardanger'])).toMatchObject({ value: 0.2, level: 'medium' });
  });

  it('matches Latin keywords as whole words only, so a short word never hides inside another (#1317 review)', () => {
    expect(topicRelevance([post('Party planning: wedding cake')], ['art'])).toMatchObject({ value: 0, level: 'low' });
    expect(topicRelevance([post('Paper art for kids'), post('My arts and crafts'), post('#art')], ['art']))
      .toMatchObject({ value: 1, matched: 3 });
    // A joined hashtag still names a longer keyword word; Chinese stays a substring.
    expect(topicRelevance([post('#hardangerembroidery #needlework')], ['hardanger embroidery'])).toMatchObject({ matched: 1 });
    expect(topicRelevance([post('#苏绣教学')], ['苏绣'])).toMatchObject({ matched: 1 });
  });

  it('counts a post the supplier repeated only once, like the account\'s other metrics (#1317 review)', () => {
    const repeated = post('hardanger lesson', 'same');
    const posts = [...Array(11).fill(repeated), ...Array.from({ length: 19 }, () => post('other'))];
    expect(topicRelevance(posts, ['hardanger'])).toEqual({ value: 0.05, matched: 1, analyzed: 20, level: 'low' });
  });

  it('says nothing without keywords or titled posts (unknown, not "low")', () => {
    expect(topicRelevance([post('hardanger')], [])).toBeNull();
    expect(topicRelevance([post()], ['hardanger'])).toBeNull();
    expect(topicRelevance([post('hardanger')], ['  '])).toBeNull();
  });
});
