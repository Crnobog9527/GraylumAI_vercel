/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { consentedTopicIds } from './adoption-consent';

const ids = ['one', 'two', 'three'];
describe('natural-language topic adoption consent', () => {
  it('binds explicit ordinal and all instructions to the offered IDs', () => {
    expect(consentedTopicIds('采用第二条选题', ids)).toEqual(['two']);
    expect(consentedTopicIds('请采纳第 3 条内容。', ids)).toEqual(['three']);
    expect(consentedTopicIds('采用第一条和第三条选题', ids)).toEqual(['one','three']);
    expect(consentedTopicIds('采用全部选题', ids)).toEqual(ids);
  });
  it('finds the instruction in a longer message, with the topic title around it (turn 61 on staging)', () => {
    const titles = ['One hour of prep for a week of baby meals', 'Second', 'Third'];
    expect(consentedTopicIds('三条都做短视频，请采用第一条 One hour of prep for a week of baby meals 作为选题。', ids, titles)).toEqual(['one']);
    expect(consentedTopicIds('好的，采用第二条吧', ids)).toEqual(['two']);
    expect(consentedTopicIds('采用第一条，第三条', ids)).toEqual(['one', 'three']);
    expect(consentedTopicIds('三条都做视频，采用第一条,第三条。', ids)).toEqual(['one', 'three']);
    expect(consentedTopicIds('采用第一条 some other words', ids, titles)).toBeNull();
    expect(consentedTopicIds('采用第一条，再采用第二条', ids)).toBeNull();
    expect(consentedTopicIds('先别采用，采用第一条', ids)).toBeNull();
  });
  it('does not adopt when the form the message names is not the topic\'s', () => {
    const video = ['video', 'video', 'video'], mixed = ['article', 'video', undefined];
    expect(consentedTopicIds('三条都做短视频，请采用第一条', ids, [], video)).toEqual(['one']);
    expect(consentedTopicIds('三条都做短视频，请采用第一条', ids, [], mixed)).toBeNull();
    expect(consentedTopicIds('三条都做短视频，请采用第三条', ids, [], mixed)).toBeNull();
    expect(consentedTopicIds('三条都做短视频，请采用全部选题', ids, [], mixed)).toBeNull();
    expect(consentedTopicIds('请采用第二条', ids, [], mixed)).toEqual(['two']);
    expect(consentedTopicIds('三条都做文章，请采用第一条', ids, [], mixed)).toEqual(['one']);
  });
  it('refuses an instruction that is quoted, an example or reported, and anything else around it that is not on the short list', () => {
    for (const message of ['比如，采用第一条', '示例指令：\n采用第一条', '例如采用第一条', '假设我说，采用第一条', '他说，采用第一条',
      '采用第一条，顺便举个例子', '采用第一条，三条都做视频', '三条都行，采用第一条', '"采用第一条"，这样写对吗'])
      expect(consentedTopicIds(message, ids)).toBeNull();
    expect(consentedTopicIds('好的，采用第二条吧', ids)).toEqual(['two']);
    expect(consentedTopicIds('三条都做短视频，请采用第一条', ids)).toEqual(['one']);
  });
  it('refuses an instruction that is not in force yet', () => {
    for (const message of ['等我确认后，采用第一条', '采用第一条，等我确认后再保存', '如果可以，采用第一条', '明天再采用第一条', '采用第一条，之后再说'])
      expect(consentedTopicIds(message, ids)).toBeNull();
    // A title quoted after its own ordinal is a quote; the same words elsewhere are the user's.
    expect(consentedTopicIds('请采用第一条 如果等你有空 作为选题', ids, ['如果等你有空', 'b', 'c'])).toEqual(['one']);
    expect(consentedTopicIds('不要采用第一条', ids, ['不要', 'b', 'c'])).toBeNull();
    expect(consentedTopicIds('如果可以，采用第一条', ids, ['如果可以', 'b', 'c'])).toBeNull();
    expect(consentedTopicIds('采用第二条 如果等你有空', ids, ['如果等你有空', 'b', 'c'])).toBeNull();
  });
  it('refuses questions, vague agreement, negation and out-of-range selection', () => {
    for (const message of ['不要采用第一条', '采用第一条吗？', '好，继续', '先看看第二条', '采用第四条', '别人说采用第一条',
      '采用第一条和', '采用和第一条', '采用第一条和选题']) {
      expect(consentedTopicIds(message, ids)).toBeNull();
    }
  });
});
