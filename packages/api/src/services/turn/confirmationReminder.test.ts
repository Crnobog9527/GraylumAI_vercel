/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { asksToReplyContinue, confirmationReminderFilter, dropConfirmationReminder, dropsConfirmationReminder, replySentenceFilter } from './confirmationReminder';

// Owner 2026-11-27 pay2 (second run): seq 18 asked for the confirmation card; seq 20 and 22, the coach's own words, asked again
// although the host had marked the turn confirmationAsked.
const SEQ20 = '这条补充我记下了：场地先看按次预约的共享空间，不会一开始签长期租约。这和你"先做三四人小班、每场两三个小时、确认有人报名再加场次"'
  + '的节奏是对得上的，后面设计变现路径时，我会按"按次租场地、先少量场次"来考虑，不会假设你已经有固定场地。具体租金和哪个空间，你还没说，我先不假设。\n\n'
  + '第一步的确认卡片还在聊天里。你核对完左侧内容，没问题的话点一下卡片就行。';
const SEQ22 = '这条课程细节我记下了：第一场先教入门卡包，不放复杂图案，也不用需要额外工具的步骤。这样更容易在两三个小时内做完一件成品，'
  + '和你"三四人小班、每场两三个小时"的安排也对得上。后面设计变现路径和选题时，我会按"入门卡包、步骤简单"来考虑。材料费、定价和具体工具清单你还没说，我先不假设。\n\n'
  + '第一步的确认卡片还在聊天里。你核对完左侧内容，没问题的话点一下卡片就行。';
// Delivered in pieces of every size, as a stream does.
const streamed = (text: string, size: number) => {
  const filter = confirmationReminderFilter(true);
  let out = '';
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
  return out + filter.flush();
};

describe('a repeated request for the confirmation card is dropped before it is shown (pay2 seq 20, 22)', () => {
  it.each([['seq 20', SEQ20], ['seq 22', SEQ22]])('%s keeps what the coach recorded and loses both reminder sentences', (_name, reply) => {
    const out = dropConfirmationReminder(reply);
    expect(out).not.toContain('确认卡片');
    expect(out).not.toContain('点一下卡片');
    expect(out).toContain('我记下了');
    expect(out).toContain('我先不假设。');
    for (const size of [1, 2, 3, 7, 50, 10000]) expect(streamed(reply, size)).toBe(out);
  });
  it('keeps bold intact, keeps sentences that do not ask, and an English request is dropped too', () => {
    expect(dropConfirmationReminder('记下了。**请点击聊天里的确认卡片。**还有一个问题？')).toBe('记下了。还有一个问题？');
    expect(dropConfirmationReminder('Noted. Please click the confirmation card in the chat. Anything else?')).toBe('Noted. Anything else?');
    expect(dropConfirmationReminder('卡包的材料费你问过吗？')).toBe('卡包的材料费你问过吗？');
    // Review of #2059: a sentence that only mentions the card is the coach's answer, not a request; it stays.
    const mention = '我把你补充的每场三四人记下了，确认卡里的课程规模也会据此更新。场地仍按次预约。';
    expect(dropConfirmationReminder(mention)).toBe(mention);
    expect(dropConfirmationReminder('The confirmation card now shows four people per class. Noted.'))
      .toBe('The confirmation card now shows four people per class. Noted.');
  });
  it('is off unless the host marked the turn, and off when the user asks to go on in words (the coach points to the card once)', () => {
    const off = confirmationReminderFilter(false);
    expect(off.push(SEQ20) + off.flush()).toBe(SEQ20);
    expect(dropsConfirmationReminder(false, '再补一条')).toBe(false);
    expect(dropsConfirmationReminder(true, '再补一条：场地我会先看按次预约的共享空间。')).toBe(true);
    for (const words of ['继续', '下一步', '好的', '没问题。', 'continue']) expect(dropsConfirmationReminder(true, words)).toBe(false);
  });
});

// pay4 2026-11-27, seq 26 (the real reply): the round ran out of lookups and goes on by itself, yet the coach asked the user to
// reply "继续".
const SEQ26 = '收到你确认的 8 个关键词，我已经在小红书上开始找杭州的本地同行了。\n\n这一轮还没搜完，目前只拿到了几个候选账号。'
  + '它们的粉丝量、最近有没有更新，还要等取到作品数据后再核对，所以现在还不能算合格对标。我会扩大范围接着搜，已经取过的数据不会重复取。\n\n'
  + '如果下一条消息没有自动接着搜，你回我一句"继续"就行。';
describe('a search that goes on by itself: the host drops a request to reply "continue"', () => {
  const run = (active: boolean, text: string, size: number) => {
    const filter = replySentenceFilter(() => active, asksToReplyContinue);
    let out = '';
    for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
    return out + filter.flush();
  };
  it('drops the sentence of seq 26 however the reply is streamed, and keeps the rest', () => {
    const kept = SEQ26.slice(0, SEQ26.lastIndexOf('如果下一条'));
    for (const size of [1, 3, 9, 10000]) expect(run(true, SEQ26, size)).toBe(kept);
    expect(run(true, SEQ26, 5)).not.toContain('继续');
  });
  it('drops other ways of asking, in both languages, and keeps sentences that only say it goes on', () => {
    for (const ask of ['没有自动继续的话，回复“继续”即可。', '你说一声继续就行。', 'If it stops, just reply "continue".',
      // Review of #2062: a zh-Hant reply.
      '請回覆「繼續」即可接著搜尋。', '請輸入「繼續」。', '你說一聲繼續就行。', '沒有自動接著搜的話，回我一句「繼續」就好。'])
      expect(asksToReplyContinue(ask)).toBe(true);
    for (const keep of ['我会扩大范围接着搜。', '下一条回复会自动继续搜。', 'The search will continue on its own.', '下一條回覆會自動繼續搜。'])
      expect(asksToReplyContinue(keep)).toBe(false);
  });
  it('is off on a turn whose search does not go on', () => expect(run(false, SEQ26, 4)).toBe(SEQ26));
});

// Review of #2062: the confirmation reminder in Traditional characters (reply language zh-Hant).
describe('a repeated request for the confirmation card in Traditional characters', () => {
  it('is dropped like the Simplified one, and a sentence that only mentions the card is kept', () => {
    expect(dropConfirmationReminder('記下了。第一步的確認卡片還在聊天裡。請點一下卡片確認這一步。還有一個問題？')).toBe('記下了。還有一個問題？');
    expect(dropConfirmationReminder('記下了。卡片仍在對話中，你核對完就請確認。')).toBe('記下了。');
    const mention = '我把每場三四人記下了，確認卡裡的課程規模也會據此更新。';
    expect(dropConfirmationReminder(mention)).toBe(mention);
  });
  it('a verbal go-ahead in Traditional characters is not filtered (the coach points to the card once)', () => {
    for (const words of ['繼續', '沒問題。', '確認']) expect(dropsConfirmationReminder(true, words)).toBe(false);
  });
});
