/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailSection, FieldChange, RulingFields, Seat } from './jury-events';
import { REPORT_SECTIONS } from './jury-mock-reviews';

/**
 * Mock summary of fusionReview.detail: one entry per template chapter (last is "全文"), each with the panel's
 * rulings, whether the revision changed it, the original and revised text, the field changes and the chapters that
 * must be chosen together. Text is shortened to an excerpt of each chapter; the real endpoint returns the full text.
 */
const rule = (section: string, issue: string, reviewers: Seat[], disputed: boolean, adopted: boolean,
  texts: { opinion: string; reason: string; fix: string }): RulingFields =>
  ({ section, issue, reviewers, single: reviewers.length === 1, disputed, adopted, ...texts });

const field = (stepId: string, fieldId: string, before: string, after: string): FieldChange => ({ stepId, fieldId, before, after });

const CH2 = '第 2 章 定位一句话';
const CH3 = '第 3 章 差异化';
const CH4 = '第 4 章 受众画像';
const CH6 = '第 6 章 平台选择';
const CH9 = '第 9 章 内容支柱';
const CH10 = '第 10 章 变现路径';
const CH12 = '第 12 章 30 天行动';

export const REVISION_TEXT: Record<string, { original: string; revised: string }> = {
  [CH3]: {
    original: '和同类账号相比，你的内容更快：每道菜 15 分钟以内上桌。',
    revised: '和同类账号相比，你快在备菜：周日一次切配，工作日三天复用，每道菜 15 分钟以内上桌。',
  },
  [CH4]: {
    original: '核心受众：25–32 岁、在一二线城市刚开始独居的上班族，以及想控制饮食的健身新手。',
    revised: '核心受众：25–32 岁、在一二线城市刚开始独居的上班族。他们多在 19–20 点到家，厨房只有单灶和小冰箱，'
      + '最常因为太累、买菜麻烦、一个人吃不完而放弃做饭。以后可以扩展的人群：想控制饮食的健身新手。',
  },
  [CH6]: {
    original: '主平台：小红书。理由：菜谱靠搜索被找到，新号也有机会被搜到。',
    revised: '主平台：小红书。理由：菜谱靠搜索被找到，新号也有机会被搜到。同一条视频同步发布到抖音，'
      + '观察双职工家庭用户的反馈，第二个月再决定要不要加重。',
  },
  [CH9]: {
    original: '三个内容支柱：15 分钟晚饭、一周不重样、厨房好物。',
    revised: '三个内容支柱：15 分钟晚饭、一周不重样、备菜和收纳。',
  },
  [CH10]: {
    original: '变现路径：先接厨具和半成品品牌合作；之后推出付费食谱，价格参照同类账号先定一个区间。',
    revised: '变现路径：第一个月上线免费周菜单，用报名表收集愿意付钱的人；第三个月按报名情况决定是否推出付费版。'
      + '品牌合作放到第二步。',
  },
  [CH12]: {
    original: '前两周每天更新一条；第三周开始接触品牌。',
    revised: '每周三更（周二、周四、周日），周末集中拍两条备用；第一周上线免费周菜单报名表；'
      + '每周日花二十分钟整理评论区问题，排进下周选题。',
  },
};

type SectionPlan = { rulings: RulingFields[]; fields?: FieldChange[]; wordingOnly?: boolean; linked?: string[] };

function sections(plan: Record<string, SectionPlan>): DetailSection[] {
  return REPORT_SECTIONS.map(section => {
    const entry = plan[section];
    const text = REVISION_TEXT[section];
    const changed = Boolean(entry && text && entry.rulings.some(item => item.adopted));
    return {
      section, changed, rulings: entry?.rulings ?? [], wordingOnly: Boolean(changed && entry?.wordingOnly),
      ...(changed ? { original: text.original, revised: text.revised } : {}),
      fields: changed ? entry?.fields ?? [] : [], linkedSections: changed ? entry?.linked ?? [] : [],
    };
  });
}

const R_DIFF = rule(CH3, '没说清快在哪个环节', ['C'], false, true, {
  opinion: '差异化要写明快在备菜，而不只是「更快」。',
  reason: '只有一位评审提出，但回到原文核实：第 3 章只有「更快」两个字，观众确实记不住快在哪里。',
  fix: '写明「周日一次切配，工作日三天复用」。',
});
const R_DETAIL = rule(CH4, '受众画像缺少生活细节', ['A'], false, true, {
  opinion: '受众画像要补上到家时间、厨房条件和放弃做饭的原因。',
  reason: '原文只写了年龄和城市；选题要对应具体场景，这三项是最常用的选题来源。',
  fix: '补上 19–20 点到家、单灶和小冰箱、太累／买菜麻烦／吃不完三个原因。',
});
const R_FIT = rule(CH4, '健身新手前后不一致', ['C'], false, true, {
  opinion: '健身新手移出核心受众，放进「以后可以扩展的人群」。',
  reason: '正文把他们算进核心受众，附录却只提了一次，会让选题在「快」和「健康」之间摇摆。',
  fix: '核心受众只留独居上班族，健身新手作为以后的扩展人群。',
});
const R_SALT = rule(CH2, '定位补一句「少油少盐」', ['B'], false, false, {
  opinion: '定位一句话保持不变，「少油少盐」写进账号简介。',
  reason: '加进定位会让一句话变长、焦点变散；原文「15 分钟家常菜」的最强理由是好记、能被验证。',
  fix: '定位不改；账号简介里加一句「少油少盐」。',
});
const R_PILLAR = rule(CH9, '「厨房好物」偏离主题', ['A'], false, true, {
  opinion: '「厨房好物」改为「备菜和收纳」。',
  reason: '这个支柱做多了容易变成带货号，削弱「15 分钟」的承诺；改成备菜仍然服务于「快」。',
  fix: '第三个支柱改为「备菜和收纳」。',
});
const R_CADENCE = rule(CH12, '前两周每天更新和空闲时间冲突', ['A'], false, true, {
  opinion: '更新节奏改为每周三更。',
  reason: '只有一位评审提出，但和你在第 1 章写下的「每天只有一小时空闲」直接冲突，属于关键问题。',
  fix: '每周二、四、日更新，周末集中拍两条备用，第三周起再看要不要加量。',
});
const R_COMMENTS = rule(CH12, '没安排在评论区收集问题', ['C'], false, true, {
  opinion: '每周固定整理一次评论区问题，作为下周选题。',
  reason: '这是最省力、也最贴近受众的选题来源，原计划漏掉了。',
  fix: '每周日花二十分钟整理评论区，挑一到两个问题排进下周。',
});

const PLAN_FIELDS = field('plan', 'cadence', '每天一更', '每周三更，周末备两条');
const MONEY_FIELD = field('monetization', 'firstStep', '品牌合作', '免费周菜单收集付费意愿');

export const SECTIONS_FULL: DetailSection[] = sections({
  [CH2]: { rulings: [R_SALT] },
  [CH3]: { rulings: [R_DIFF], wordingOnly: true },
  [CH4]: { rulings: [R_DETAIL, R_FIT], fields: [field('audience', 'core', '独居上班族、健身新手', '独居上班族')] },
  [CH6]: {
    rulings: [
      rule(CH6, '主平台是否改为抖音', ['A'], true, false, {
        opinion: '保留小红书为主平台，抖音作为同步发布。',
        reason: '改动方的最强理由是做饭过程适合竖屏、起量快；保留方的最强理由是新号要先被搜到，标题写法也是为搜索设计的。'
          + '第 2 轮仍是一对二，回到原文：第 2 章和第 12 章都按搜索型内容安排，换主平台要重排全部计划。',
        fix: '主平台不变；同一条视频同步发布到抖音，第二个月看反馈再决定。',
      }),
      rule(CH6, '漏掉家庭用户常用的平台', ['B', 'A'], false, true, {
        opinion: '同步发布到抖音，覆盖双职工家庭用户。',
        reason: '两位评审从不同角度都提到抖音：一位为了起量，一位为了家庭用户。同步发布不增加拍摄量，成本很低。',
        fix: '每条视频同时发小红书和抖音，记录两边的收藏和评论。',
      }),
    ],
    fields: [field('platform', 'secondary', '无', '抖音（同步发布）')],
  },
  [CH9]: { rulings: [R_PILLAR], fields: [field('content', 'pillars', '15 分钟晚饭／一周不重样／厨房好物', '15 分钟晚饭／一周不重样／备菜和收纳')] },
  [CH10]: {
    rulings: [rule(CH10, '先做周菜单，还是先接品牌合作', ['B', 'C'], true, true, {
      opinion: '先上线免费周菜单收集付费意愿，品牌合作放到第二步；删掉没有依据的价格区间。',
      reason: '保留方的最强理由是品牌合作门槛低、不用做产品；改动方的最强理由是能在三个月内验证有没有人愿意付钱，'
        + '这正是你在第 10 章写下的目标。第 2 轮里原来主张保留的评审也被说服了。',
      fix: '第一个月上线免费周菜单报名表，第三个月按报名情况决定是否推出付费版和定价。',
    })],
    fields: [MONEY_FIELD],
    linked: [CH12],
  },
  [CH12]: { rulings: [R_CADENCE, R_COMMENTS], fields: [PLAN_FIELDS, MONEY_FIELD], linked: [CH10] },
});

export const SECTIONS_CONSENSUS: DetailSection[] = sections({
  [CH4]: { rulings: [R_DETAIL, R_FIT], fields: [field('audience', 'core', '独居上班族、健身新手', '独居上班族')] },
  [CH10]: {
    rulings: [rule(CH10, '前三个月没有收入来源', ['B', 'A', 'C'], false, true, {
      opinion: '先上线免费周菜单收集付费意愿，品牌合作放到第二步。',
      reason: '三位评审在变现路径上都主张先验证付费，原文的品牌合作要等账号有规模才会来。',
      fix: '第一个月上线免费周菜单报名表，第三个月按报名情况决定是否推出付费版。',
    })],
    fields: [MONEY_FIELD],
    linked: [CH12],
  },
  [CH12]: { rulings: [R_CADENCE], fields: [PLAN_FIELDS, MONEY_FIELD], linked: [CH10] },
  [CH6]: {
    rulings: [rule(CH6, '漏掉家庭用户常用的平台', ['B'], false, false, {
      opinion: '这一版不加平台。',
      reason: '核心受众是独居上班族，家庭用户不是这一版的重点；一个人同时顾两个平台，容易两边都做不好。',
      fix: '不改；账号稳定后再考虑同步发布。',
    })],
  },
});

export const changedTitles = (list: DetailSection[]) => list.filter(item => item.changed).map(item => item.section);
export const changedFieldCount = (list: DetailSection[]) =>
  new Set(list.flatMap(item => item.fields.map(change => `${change.stepId}.${change.fieldId}`))).size;
