/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// A model reply can identify candidate IDs, but it cannot authorize a write.
// Only an unambiguous instruction in the persisted user turn may do that. The instruction may name the topic's title and may follow a
// clause that only says what form the topics take, or a spoken filler. Anything else around it (an example, a quote, a condition, a
// question, a later time) is not on that short list, so it consents to nothing: the list is what is allowed, never what is refused.
const FORM = /^[一二三四五六七八九十两\d]+条都?(?:做|定为|是|用)?(?:成)?(?:短?视频|文章|图文)$/;
const FILLER = /^(?:好的?|行|可以|嗯|那就|那)$/;
const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function ordinal(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  if (numerals[value]) return numerals[value];
  const tens = value.match(/^([一二])?十([一二三四五六七八九])?$/);
  return tens ? (tens[1] ? numerals[tens[1]] : 1) * 10 + (tens[2] ? numerals[tens[2]] : 0) : NaN;
}

const FORM_OF: Record<string, string> = { 视频: 'video', 短视频: 'video', 文章: 'article', 图文: 'image_text' };

/** The form the message says the topics take ("三条都做短视频"), if it says one. */
export function statedForm(input: string | null): string | null {
  for (const clause of (input ?? '').split(/[，,。！!；;\n]+/).map(c => c.trim())) {
    if (FORM.test(clause)) return FORM_OF[clause.match(/(短?视频|文章|图文)$/)![1]] ?? null;
  }
  return null;
}

/**
 * types: each candidate's contentType, in the order of candidateIds. When the message names a form and a chosen topic is of another (or
 * of none yet), the page does not adopt: the work item takes the topic's form, so the form is changed first and then confirmed.
 */
export function consentedTopicIds(input: string | null, candidateIds: string[], titles: readonly string[] = [],
  types?: readonly (string | undefined)[]): string[] | null {
  // A title quoted right after its own ordinal is the user's quote, not their words: what it says neither asks nor refuses. The same
  // words anywhere else are the user's.
  const message = titles.reduce((text, title, index) => {
    if (!title) return text;
    const quoted = new RegExp('(第\\s*([一二三四五六七八九十两\\d]+)\\s*条(?:选题|内容)?)\\s*[《“"「]?' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[》”"」]?', 'g');
    return text.replace(quoted, (whole: string, head: string, number: string) => ordinal(number) === index + 1 ? head : whole);
  }, input?.trim() ?? '');
  if (/[?？吗]|不要|不用|别|先不|暂不|是否/.test(message)) return null;
  // Not yet in force: a condition or a later time anywhere keeps it from being consent now.
  if (/等|后|待|稍|回头|如果|假如|要是|若|再|考虑|看看/.test(message)) return null;
  // A comma also separates a list: an ordinal-only clause after the instruction stays with it.
  const clauses = message.split(/[，,。！!；;\n]+/).map(clause => clause.trim()).filter(Boolean);
  const first = clauses.findIndex(clause => /采用|采纳/.test(clause));
  if (first < 0 || clauses.filter(clause => /采用|采纳/.test(clause)).length !== 1) return null;
  if (!clauses.slice(0, first).every(clause => FORM.test(clause) || FILLER.test(clause))) return null;
  let last = first;
  while (last + 1 < clauses.length && /^第\s*[一二三四五六七八九十两\d]+\s*条(?:选题|内容)?$/.test(clauses[last + 1])) last += 1;
  if (last + 1 < clauses.length) return null; // nothing may follow the instruction but more ordinals
  const match = clauses.slice(first, last + 1).join('，').trim().match(/^(?:请|帮我|我要|我想|现在|只|就|把|将|\s)*(?:采用|采纳)\s*(.*?)\s*(?:作为选题|吧|就好|即可)?$/);
  if (!match || candidateIds.length === 0) return null;
  const selection = match[1].trim();
  if (/^(?:全部|所有)(?:选题|内容)?$/.test(selection)) {
    const all = statedForm(message);
    return all && types && candidateIds.some((_id, index) => types[index] !== all) ? null : [...candidateIds];
  }
  const token = /第\s*([一二三四五六七八九十两\d]+)\s*条(?:选题|内容)?/g;
  const parts = [...selection.matchAll(token)];
  if (!parts.length || !/^#(?:\s*(?:、|,|，|和|及|与|以及)\s*#)*$/.test(selection.replace(token, '#'))) return null;
  const positions = [...new Set(parts.map(part => ordinal(part[1])))];
  if (!positions.every(position => Number.isInteger(position) && position >= 1 && position <= candidateIds.length)) return null;
  const form = statedForm(message);
  if (form && types && positions.some(position => types[position - 1] !== form)) return null;
  return positions.map(position => candidateIds[position - 1]);
}

/** consentedTopicIds for the candidate the user saw: its ids, titles and forms. */
export function consentedForCandidate(input: string | null, body: readonly { id: string; title: string; contentType?: string }[]): string[] | null {
  return consentedTopicIds(input, body.map(item => item.id), body.map(item => item.title), body.map(item => item.contentType));
}
