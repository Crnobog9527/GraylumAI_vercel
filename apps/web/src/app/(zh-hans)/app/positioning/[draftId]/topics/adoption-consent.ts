/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// A model reply can identify candidate IDs, but it cannot authorize a write.
// Only an unambiguous instruction in the persisted user turn may do that.
export function consentedTopicIds(input: string | null, candidateIds: string[]): string[] | null {
  const message = input?.trim() ?? '';
  const match = message.match(/^(?:请|帮我|我要|我想|现在|只|就|把|将|\s)*(?:采用|采纳)\s*(.*?)\s*[。！!]*$/);
  if (!match || candidateIds.length === 0) return null;
  const selection = match[1].trim();
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
