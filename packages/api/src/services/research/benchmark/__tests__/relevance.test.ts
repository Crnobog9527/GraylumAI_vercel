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

  it('counts a Chinese phrase worded another way, but not one shared word or an unrelated title (BENCHMARK-COVERAGE)', () => {
    const keywords = ['上班族快手晚餐', '15分钟晚餐', '工作日晚餐'];
    // 打工人快手晚餐 shares 快手/手晚/晚餐 (3 of 6 pairs) with the first keyword; 15分钟晚餐 is named verbatim; 晚餐 recurs in
    // all three keywords, so a title with it alone counts too.
    const series = [post('打工人快手晚餐｜青椒小炒鸡肉片🍛'), post('打工人快手晚餐 | 菜多多韩式拌饭'), post('下班后15分钟晚餐搞定'),
      post('打工人晚餐｜青椒肉丝🔥巨下饭'), post('一人食｜腊肠菌菇鸡腿饭')];
    expect(topicRelevance(series, keywords)).toEqual({ value: 0.8, matched: 4, analyzed: 5, level: 'high' });
    // Clickbait titles that never name the niche stay low, whatever the account really cooks.
    const clickbait = [post('答应我！一定要试试这道菜！！', 'a'), post('分享300碗拌米饭🥣day222碗！', 'b'), post('好吃到破防😭求你们都去做！！', 'c')];
    expect(topicRelevance(clickbait, keywords)).toMatchObject({ value: 0, level: 'low' });
    // A pair counts alone only when two keywords share it; one short keyword stays verbatim.
    expect(topicRelevance([post('今天吃晚饭')], ['晚餐'])).toMatchObject({ matched: 0 });
    expect(topicRelevance([post('一人食｜腊肠饭')], ['上班族快手晚餐', '工作日晚餐'])).toMatchObject({ matched: 0 });
    expect(topicRelevance([post('今天吃晚餐')], ['晚餐'])).toMatchObject({ matched: 1 });
  });

  it('says nothing without keywords or titled posts (unknown, not "low")', () => {
    expect(topicRelevance([post('hardanger')], [])).toBeNull();
    expect(topicRelevance([post()], ['hardanger'])).toBeNull();
    expect(topicRelevance([post('hardanger')], ['  '])).toBeNull();
  });
});
