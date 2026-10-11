/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Many PDF writers (Chrome's "Save as PDF" among them) build the ToUnicode table from the font's
 * character map. CJK fonts map radical code points and the ordinary character to the same glyph, and
 * the writer keeps the lowest code point, so 方 comes out as the Kangxi radical ⽅ (U+2F45) and 见 as
 * ⻅ (U+2EC5). The text looks right but no longer matches searches or the model's vocabulary.
 *
 * Kangxi Radicals (U+2F00–U+2FD5) have Unicode compatibility mappings (NFKC). CJK Radicals Supplement
 * characters mostly do not; the pairs below are the ones Noto Sans CJK SC and Source Han Serif SC
 * draw with the very same glyph as the listed character (read from the fonts' character maps).
 */
const SUPPLEMENT_PAIRS = [
  '⺂乛⺃乚⺅亻⺇𠘨⺉刂⺋㔾⺍𭕄⺎兀⺏尣⺐尢⺒巳⺓幺⺔彑⺕彐⺖忄⺘扌⺙攵⺛旡⺞歺⺟母⺠民⺡氵⺣灬⺤爫⺦丬⺨犭⺩𤣩⺫罒',
  '⺭礻⺮𥫗⺯糹⺰纟⺱罓⺲罒⺳㓁⺹耂⺺肀⺽𦥑⺾艹⻁虎⻂衤⻃覀⻅见⻆角⻇𧢲⻈讠⻉贝⻊𧾷⻋车⻌辶⻐钅⻑長⻒镸⻓长⻔门⻕𨸏',
  '⻖阝⻘青⻙韦⻚页⻛风⻜飞⻝食⻞𩙿⻟飠⻠饣⻡𩠐⻢马⻣骨⻤鬼⻥鱼⻦鸟⻧卤⻨麦⻩黄⻪黾⻫斉⻬齐⻮齿⻯竜⻰龙⻱龜⻲亀⻳龟',
].join('');

const SUPPLEMENT = new Map<string, string>();
const pairs = Array.from(SUPPLEMENT_PAIRS);
for (let index = 0; index + 1 < pairs.length; index += 2) SUPPLEMENT.set(pairs[index], pairs[index + 1]);

const RADICAL = /[\u2E80-\u2EFF\u2F00-\u2FD5]/gu;

export function normalizeCjkRadicals(text: string): string {
  return text.replace(RADICAL, (char) => SUPPLEMENT.get(char) ?? (char >= '\u2F00' ? char.normalize('NFKC') : char));
}
