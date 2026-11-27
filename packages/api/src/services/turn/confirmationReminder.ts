/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReplyLocale } from '../../shared/replyLocales';

/*
 * Owner 2026-11-27 (pay2, two runs): with the step ready and the confirmation card already asked for, the coach kept asking
 * again (seq 12-18 of the first run; seq 20 and 22 of the second, after the host had told it so with confirmationAsked). The
 * card stays on screen, so the host itself drops a sentence that asks for it again, before the user sees it: the reply is
 * streamed sentence by sentence and what is shown is what is saved. Only on a turn the host marked confirmationAsked, and not
 * when the user asks to go on in words (the coach then points to the card once, agentTurnPrompt.ts).
 */
// A request names the card and asks for it: click it, go confirm, or that it is still in the chat. A sentence that only mentions
// the card ("确认卡里的课程规模也会更新") is kept (review of #2059).
const CARD = /确认卡|確認卡|卡片|confirmation card|the card/i;
// Simplified and Traditional forms both (review of #2062: a zh-Hant reply is written in Traditional characters).
const ASK = new RegExp(['点', '點', '按一下', 'click', 'tap', 'press', '(还|還|仍)在(聊天|对话|對話)', '在聊天(里|裡)',
  'still (in|on) (the )?(chat|screen)', '(请|請).{0,8}(确认|確認)', '去(确认|確認)', 'confirm (this|the) step'].join('|'), 'i');
const ASSENT = /^\s*(继续|繼續|下一步|没问题|沒問題|好的?|可以|行|确认|確認|ok(ay)?|next|continue|go on)[\s。.!！~～了吧啊呀]*$/i;
const END = '。！？!?';
const CLOSER = '*”"’）)」』';

/** Whole sentences at the start of text (each with its end mark and closing marks, or one line break), and what is left. */
function sentences(text: string, final: boolean): { done: string[]; rest: string } {
  const done: string[] = [];
  let start = 0, i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n') { if (i > start) done.push(text.slice(start, i)); done.push('\n'); start = i + 1; i += 1; continue; }
    const english = c === '.' && /\s/.test(text[i + 1] ?? (final ? ' ' : ''));
    if (END.includes(c) || english) {
      let j = i + 1;
      while (j < text.length && (END.includes(text[j]!) || CLOSER.includes(text[j]!))) {
        // Bold marks close this sentence only when it opened bold; otherwise they open the next one.
        if (text[j] === '*' && (text.slice(start, j).split('**').length - 1) % 2 === 0) break;
        j += 1;
      }
      // A mark at the very end may still get its closing marks in the next delta.
      if (j === text.length && !final) break;
      done.push(text.slice(start, j)); start = j; i = j; continue;
    }
    i += 1;
  }
  return { done, rest: text.slice(start) };
}
/** A sentence that asks again for the confirmation card. */
export const asksForConfirmationCard = (sentence: string) => CARD.test(sentence) && ASK.test(sentence);

/*
 * pay4 2026-11-27, seq 26: a discovery round that ran out of lookups goes on by itself (the page sends the next reply, Owner
 * 2026-10-23, 3 A: the user types nothing), yet the coach told the user to reply "继续" if it did not. On a turn whose search
 * goes on, the host drops a sentence that asks the user to reply "continue"; the page itself says so past its limit.
 */
const REPLY_CONTINUE = /(回|回复|回覆|說|说|发|發|打|输入|輸入|鍵入|键入)(我|一下|给我|給我)?(一句|一声|一聲|个|個)?\s*[“"「『‘']?(继续|繼續)|\b(reply|say|type|send)\b[^.!?。！？]{0,12}\bcontinue\b/i;
export const asksToReplyContinue = (sentence: string) => REPLY_CONTINUE.test(sentence);

/** What the reply says when it was nothing but that request (review of #2062): the search goes on, the user replies nothing. */
export const SEARCH_GOES_ON: Record<ReplyLocale, string> = { 'zh-Hans': '还在接着搜，搜完会直接告诉你。',
  'zh-Hant': '還在接著搜，搜完會直接告訴你。', en: "Still searching. I'll tell you as soon as it's done." };

/** Whether this turn drops repeated requests: the host marked it, and the user did not just ask to go on. */
export const dropsConfirmationReminder = (asked: boolean, words: string) => asked && !ASSENT.test(words);

/**
 * The stream filter of one reply: push each delta and show what it returns; flush at the end. `drop` is read for every
 * sentence; while `active()` is false the filter passes text through (it may turn on between two model calls of a turn).
 */
export function replySentenceFilter(active: () => boolean, drop: (sentence: string) => boolean) {
  let buffer = '';
  const keep = (sentence: string) => !drop(sentence);
  return {
    push(delta: string): string {
      if (!active()) return delta;
      const { done, rest } = sentences(buffer + delta, false);
      buffer = rest;
      return done.filter(keep).join('');
    },
    flush(): string {
      if (!active()) return '';
      const { done, rest } = sentences(buffer, true);
      buffer = '';
      return [...done, rest].filter(keep).join('');
    },
    reset() { buffer = ''; },
  };
}

/** The confirmation-reminder filter alone (on when the turn drops repeated requests). */
export const confirmationReminderFilter = (active: boolean) => replySentenceFilter(() => active, asksForConfirmationCard);

/** The whole reply through the same filter (for a reply that was not streamed in pieces). */
export function dropConfirmationReminder(text: string): string {
  const filter = confirmationReminderFilter(true);
  return filter.push(text) + filter.flush();
}
