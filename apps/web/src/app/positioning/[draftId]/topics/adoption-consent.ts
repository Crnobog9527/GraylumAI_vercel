/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// A model reply can identify candidate IDs, but it cannot authorize a write.
// Only an unambiguous instruction in the persisted user turn may do that.
export function consentedTopicIds(input: string | null, candidateIds: string[]): string[] | null {
  const message = input?.trim() ?? '';
  const match = message.match(/^(?:请|帮我|我要|我想|现在|只|就|把|将|\s)*(?:采用|采纳)\s*(?:第\s*([一二三四五六七八九十两\d]+)\s*条(?:选题|内容)?|(全部|所有)(?:选题|内容)?)[。！!\s]*$/);
  if (!match || candidateIds.length === 0) return null;
  if (match[2]) return [...candidateIds];
  const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const ordinal = numerals[match[1]] ?? Number(match[1]);
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= candidateIds.length
    ? [candidateIds[ordinal - 1]] : null;
}
