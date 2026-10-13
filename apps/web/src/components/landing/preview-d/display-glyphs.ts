/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ, LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { SAMPLE_REPORTS_TITLE } from '@/lib/landing/landing-samples';

/**
 * Sample D's display face is Noto Sans CJK SC Black (Apache 2.0, fonts/LICENSE.txt) cut down to the glyphs of
 * the headings below plus printable ASCII, so the page loads one ~50 KB file instead of another CJK font.
 * The test checks every heading character is in the subset. After changing a heading, regenerate with:
 *   pyftsubset NotoSansHans-Black.otf --text-file=<DISPLAY_GLYPHS> --flavor=woff2 --layout-features='*' --name-IDs='*'
 *     --output-file=fonts/display-subset.woff2
 */
export const DISPLAY_TEXTS: readonly string[] = [
  HERO.title,
  VOICE_WALL.title,
  HOW_IT_WORKS.title,
  HOW_IT_WORKS.timelineTitle,
  PRICE_COMPARE.title,
  RISK_REVERSAL.title,
  LANDING_FAQ_TITLE,
  FINAL_ACTION.title,
  SAMPLE_REPORTS_TITLE,
  '推荐',
  ...FLOW_STEPS.map(step => step.title),
  ...LANDING_FAQ.map(group => group.title),
];

const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('');

/** Every character in fonts/display-subset.woff2 besides ASCII. */
export const DISPLAY_GLYPHS = '不两么买于人什他付们价体你例候做先关内写出到去发号合同后告和团在型复多媒它审容对常库得怎怨我手找报抱拿接推教料时有条标样格模现的盘看真练群聊自荐营见记评话说账费资跑路运适问陪题（），';

export const SUBSET_TEXT = ASCII + DISPLAY_GLYPHS;
