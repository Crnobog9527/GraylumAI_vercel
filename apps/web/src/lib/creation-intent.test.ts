/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { looksLikeCreationRequest } from './creation-intent';

describe('looksLikeCreationRequest', () => {
  it.each([
    '帮我写一条口播稿', '帮我写一条 60 秒的短视频口播稿，主题是早起', '给我出一版文案', '写个脚本', '这个视频的分镜怎么拍',
    '帮我想三个选题', '把这段润色一下', '起草一篇图文', '这条标题怎么改更吸引人', '开场白怎么写', '来一条小红书笔记',
    '再扩写一点，结尾加个钩子', '生成一个爆款标题', '重写一下', '换一版', '缩短到一百字',
  ])('says yes to the Chinese request %s', text => expect(looksLikeCreationRequest(text)).toBe(true));

  it.each([
    'Write a 60 second voiceover about waking up early', 'draft a caption for this reel', 'Rewrite this headline',
    'give me 5 video ideas', 'storyboard for a product demo', 'can you polish my script?', 'TikTok script please',
    'write a blog post about habits',
  ])('says yes to the English request %s', text => expect(looksLikeCreationRequest(text)).toBe(true));

  it.each([
    '你好', '今天天气怎么样', '我的积分还剩多少', '怎么升级会员', '谢谢，明白了', '什么是 SEO', '帮我看一下这个报告',
    'hello', 'how do I upgrade my plan', 'what is my balance', 'thanks, that makes sense', 'postal code lookup',
    'the scripture says', 'I am hooked on coffee',
  ])('says no to ordinary chat %s', text => expect(looksLikeCreationRequest(text)).toBe(false));

  it('says no to empty input and only scans the start of very long input', () => {
    expect(looksLikeCreationRequest('')).toBe(false);
    expect(looksLikeCreationRequest(null)).toBe(false);
    expect(looksLikeCreationRequest(undefined)).toBe(false);
    expect(looksLikeCreationRequest('嗯'.repeat(5000) + '写一条口播稿')).toBe(false);
    expect(looksLikeCreationRequest('写一条口播稿' + '嗯'.repeat(5000))).toBe(true);
  });
});
