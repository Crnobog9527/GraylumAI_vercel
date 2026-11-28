/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { offTopic, topicRelevance } from '../relevance';
import { nicheTerms } from '../nicheTerms';
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

describe('the niche of the confirmed keywords decides what is off topic (Owner 2026-11-28, H; pay4 Douyin run)', () => {
  // The keywords pay4 confirmed (seq 25): 皮具 is the only subject two keywords share; 卡包 and 皮革 come from one each.
  const keywords = ['杭州皮具手作', '皮具体验课', '杭州手作体验', '皮革DIY', '手工卡包', '闺蜜手作', '周末手作', '杭州周末去哪玩'];

  it('takes places, occasions, audiences and formats out of the keywords and keeps what two of them share', () => {
    expect(nicheTerms(keywords)).toEqual(['皮具']);
    // With no shared subject, every subject term; a one-character niche keeps the word it sits in.
    expect(nicheTerms(['手工皂教程', '冷制皂配方'])).toEqual(['手工皂', '冷制皂配方']);
    expect(nicheTerms(['上班族快手晚餐', '15分钟晚餐', '工作日晚餐'])).toEqual(['晚餐']);
    expect(nicheTerms(['leather wallet diy', 'leather craft workshop nyc', 'weekend things to do'])).toEqual(['leather']);
    // Only generic words: the niche is unknown and nothing is judged by it.
    expect(nicheTerms(['杭州周末去哪玩', '闺蜜手作'])).toEqual([]);
  });

  it('pay4: the accounts the run judged qualified make other content, a leather crafter does not', () => {
    const titles = (...list: string[]) => list.map(title => post(title));
    // 杭州非遗 (city heritage news), 云朵泡芙 (desserts), 黑手造 (paper toys): named "杭州", "手作" and "闺蜜", never 皮具.
    expect(offTopic({ name: '杭州非遗', keywords, posts: titles('杭州首部非遗爱情主题AIGC视频', '听说多发一遍能火#猫 #刺绣 #杭州非遗',
      '手工山核桃加工，这才是老底子的匠心 #杭州非遗') })).toBe(true);
    expect(offTopic({ name: '云朵泡芙', keywords, posts: titles('沉浸式给闺蜜做漂亮甜品丨青苹果甜品便当局 #手作甜品治愈系') })).toBe(true);
    expect(offTopic({ name: '黑手造', keywords, posts: titles('随机摇❗️和闺蜜要做的100件事‼️ #手工 #小手工') })).toBe(true);
    // 昕星拆卡 came from 手工卡包: a photocard pack is not the niche.
    expect(offTopic({ name: '昕星拆卡', keywords, posts: titles('#沉浸式囤卡。 #沉浸式拆自制卡包。#自制 #拆卡') })).toBe(true);
    expect(offTopic({ name: '小熊猫工作室', keywords, posts: titles('手工皮具卡包制作教程 挺长的 #手工皮艺') })).toBe(false);
    // The name alone can say it; without titled posts or a niche there is nothing to judge by.
    expect(offTopic({ name: '无它手工皮具', keywords, posts: titles('手作教程-考拉挂件') })).toBe(false);
    expect(offTopic({ name: '云朵泡芙', keywords, posts: [post()] })).toBe(false);
    expect(offTopic({ name: '云朵泡芙', keywords: ['杭州周末去哪玩'], posts: titles('甜品便当') })).toBe(false);
  });

  it('a fetched account needs at least one in ten of its posts on the niche', () => {
    const posts = (on: number) => Array.from({ length: 20 }, (_, i) => post(i < on ? '皮具卡包教程' : '今天的甜品'));
    expect(offTopic({ keywords, posts: posts(1) })).toBe(true);
    expect(offTopic({ keywords, posts: posts(2) })).toBe(false);
    // The label counts the same niche: 16 of 21 matched in the run (杭州), none now.
    expect(topicRelevance(posts(2), keywords)).toMatchObject({ matched: 2, analyzed: 20, level: 'low' });
    expect(topicRelevance([post('杭州首部非遗爱情主题视频')], keywords)).toMatchObject({ matched: 0, level: 'low' });
  });
});
