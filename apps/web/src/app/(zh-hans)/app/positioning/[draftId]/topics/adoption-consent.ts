/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// A model reply can identify candidate IDs, but it cannot authorize a write.
// Only an unambiguous instruction in the persisted user turn may do that. The instruction may sit in one clause of a longer message
// and name the topic's title too; a message with a question or a negation anywhere consents to nothing.
export function consentedTopicIds(input: string | null, candidateIds: string[], titles: readonly string[] = []): string[] | null {
  const message = input?.trim() ?? '';
  if (/[?？吗]|不要|不用|别|先不|暂不|是否/.test(message)) return null;
  // A comma also separates a list: an ordinal-only clause after the instruction stays with it.
  const clauses = message.split(/[，,。！!；;\n]+/), first = clauses.findIndex(clause => /采用|采纳/.test(clause));
  if (first < 0 || clauses.filter(clause => /采用|采纳/.test(clause)).length !== 1) return null;
  let last = first;
  while (last + 1 < clauses.length && /^\s*第\s*[一二三四五六七八九十两\d]+\s*条(?:选题|内容)?\s*$/.test(clauses[last + 1])) last += 1;
  const match = clauses.slice(first, last + 1).join('，').trim().match(/^(?:请|帮我|我要|我想|现在|只|就|把|将|\s)*(?:采用|采纳)\s*(.*?)\s*(?:作为选题|吧|就好|即可)?$/);
  if (!match || candidateIds.length === 0) return null;
  const selection = titles.reduce((text, title) => title ? text.split(title).join('') : text, match[1]).trim();
  if (/^(?:全部|所有)(?:选题|内容)?$/.test(selection)) return [...candidateIds];
  const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function ordinal(value: string): number {
    if (/^\d+$/.test(value)) return Number(value);
    if (numerals[value]) return numerals[value];
    const tens = value.match(/^([一二])?十([一二三四五六七八九])?$/);
    return tens ? (tens[1] ? numerals[tens[1]] : 1) * 10 + (tens[2] ? numerals[tens[2]] : 0) : NaN;
  }
  const token = /第\s*([一二三四五六七八九十两\d]+)\s*条(?:选题|内容)?/g;
  const parts = [...selection.matchAll(token)];
  if (!parts.length || !/^#(?:\s*(?:、|,|，|和|及|与|以及)\s*#)*$/.test(selection.replace(token, '#'))) return null;
  const positions = [...new Set(parts.map(part => ordinal(part[1])))];
  return positions.every(position => Number.isInteger(position) && position >= 1 && position <= candidateIds.length)
    ? positions.map(position => candidateIds[position - 1]) : null;
}
