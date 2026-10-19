/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';
import type { SampleData } from './sample-reports';

/**
 * Sample K: sample J slimmed down (Owner 2026-10-16/17, the 19-point distill plan in the PR). Only what changes is here;
 * everything else is sample J's copy. Where a line is the product's or the sample conversation's own words it says so;
 * the rest is NEW wording from the approved plan, for the Owner to judge on the page.
 */

/**
 * Region 3, "三个关键时刻" (Owner's pick): ask first, tell the truth with real data, hand over a plan. Each moment: what
 * happens (one sentence) and why it is not "正确的废话" (one note). `pick` names the sample conversation's messages the
 * product window shows (sample J's takeover script, by index); the third moment shows the plan as the 10-second card.
 */
export type KeyMoment = {
  id: 'ask' | 'truth' | 'plan';
  label: string;
  /** From sample J's takeover notes (the moment's caption there), shortened. */
  line: string;
  note: string;
  window?: { moment: number; pick: readonly number[] };
  needs?: readonly LandingFeature[];
};

export const K_MOMENTS: readonly KeyMoment[] = [
  {
    id: 'ask', label: '先问清你',
    line: '一次只问一个问题，问题下面带例子；是选择题时给推荐选项和理由。',
    // The coach's own words in the sample conversation.
    note: '同样是做饭账号，想记录生活和想赚钱，拍法、选平台、找对标完全不一样。所以先问你要什么，再给建议。',
    window: { moment: 0, pick: [0, 1] },
  },
  {
    id: 'truth', label: '说真话，给真实数据',
    line: '先直说这条路能不能赚钱、难在哪；再按三类找对标，用真实公开数据看差距。',
    note: '不说"你一定可以"：它会直接说"可行，但难在两处"，讲清理由；对标数据来自公开信息，查不到的写"未取到"。',
    window: { moment: 1, pick: [3, 5] },
    needs: ['research'],
  },
  {
    id: 'plan', label: '交给你一份方案',
    line: '把结论收成一句话定位，再落到第一个月具体怎么做，最后写成一份完整报告。',
    note: '方案按你说过的边界来：不露脸、下班后只有一小时，就只拍手和锅、每周两条。',
    needs: ['report'],
  },
];

/** NEW: the line that tells the visitor the panes are clickable. */
export const K_MOMENTS_PICK = '点上面的三步切换';

/**
 * The third moment's card: the 10-second card (sample J's "10 秒看懂") for the page's own person, from the real
 * report's 一句话结论 (sample-reports/office-worker.json) and what the person said.
 */
export const K_PLAN_CARD: SampleData = {
  generatedAt: '2026-10-15',
  summary: {
    who: '今年 6 月刚开始一个人住的上班族，下班后只有一小时，不想露脸',
    what: 'TikTok 为主、同步 Instagram Reels：下班后 15 分钟上桌的中式家常菜，给刚开始一个人生活的上班族',
    money: '起步走厨具和食材的联盟带货，同时用免费的"一周菜单"测试大家愿不愿意为"省事"付钱',
    first: '这周把三件套改好，拍出前两条："一口锅两菜一汤"和"冰箱剩菜三种做法"',
  },
  chapters: [],
};

/** Region 4: NEW (plan item 4) the bridge from the moments to the four groups. */
export const K_SAMPLES_BRIDGE = '换成你，会是这样';

/** Region 5, "改成一行每周节奏" (Owner's pick): five still items; an item whose capability is off is hidden. */
export const K_RHYTHM: readonly { text: string; needs: readonly LandingFeature[] }[] = [
  { text: '周一给选题', needs: ['content'] },
  { text: '按你的文风写稿', needs: ['content', 'voice'] },
  { text: '一键发多平台', needs: ['publish'] },
  { text: '周末复盘告诉你改什么', needs: ['publish'] },
  { text: '资料库记得你', needs: ['library'] },
];

/** Region 6: the two pairs kept (plan item 6: 穿搭博主 first), by their place in sample J's J_COMPARE.pairs. */
export const K_COMPARE_PICKS = [1, 3] as const;

/** Plan item 7: the button at the end of regions 4 and 6. */
export const K_CTA = '免费和教练聊聊';

/** Plan item 12: under the price button; both link to the FAQ entry on refunds and cancelling. */
export const K_PRICE_TERMS = { cancel: '随时取消', refund: '退款规则', faqId: 'faq-14' } as const;

/** Plan item 3: the jury, moved out of region 3 to one line by the price. */
export const K_GOLD_LINE = { text: 'Gold：多位顶级模型再审一遍你的报告', needs: ['fusion'] as readonly LandingFeature[] };
