/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { confirmationReminderFilter, dropConfirmationReminder, dropsConfirmationReminder } from './confirmationReminder';

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
  });
  it('is off unless the host marked the turn, and off when the user asks to go on in words (the coach points to the card once)', () => {
    const off = confirmationReminderFilter(false);
    expect(off.push(SEQ20) + off.flush()).toBe(SEQ20);
    expect(dropsConfirmationReminder(false, '再补一条')).toBe(false);
    expect(dropsConfirmationReminder(true, '再补一条：场地我会先看按次预约的共享空间。')).toBe(true);
    for (const words of ['继续', '下一步', '好的', '没问题。', 'continue']) expect(dropsConfirmationReminder(true, words)).toBe(false);
  });
});
