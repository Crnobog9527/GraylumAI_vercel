/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DecisionKey, DetailDecision, DetailIssue, DetailResponse, Seat, Verdict } from './jury-events';

/**
 * Mock full text of the three reviewers (fusionReview.detail → seats), for one fictional creator: an office worker
 * who cooks 15-minute dinners after work. Every text is what the real detail endpoint returns uncut; the event
 * summaries shown during the animation are derived from it by the 120-character rule.
 */

/** The report template's chapters, in order; the summary's last section is the whole text ("全文"). */
export const REPORT_SECTIONS = [
  '第 1 章 你是谁', '第 2 章 定位一句话', '第 3 章 差异化', '第 4 章 受众画像', '第 5 章 同类账号', '第 6 章 平台选择',
  '第 7 章 人设与语气', '第 8 章 选题方向', '第 9 章 内容支柱', '第 10 章 变现路径', '第 11 章 风险与边界',
  '第 12 章 30 天行动', '第 13 章 结语', '全文',
] as const;

/** Where each key decision is written in the report, so the result page can put the panel's votes next to it. */
export const DECISION_SECTION: Record<DecisionKey, string> = {
  positioning: '第 2 章 定位一句话',
  audience: '第 4 章 受众画像',
  platform: '第 6 章 平台选择',
  monetization: '第 10 章 变现路径',
};

const AUDIENCE_SOLO = '受众：刚开始独居的上班族';
const AUDIENCE_FAMILY = '受众：双职工家庭的做饭人';
const AUDIENCE_FIT = '受众：想控制饮食的健身新手';
const SELF = '用户本人';

type Steelman = Omit<DetailDecision, 'decision' | 'verdict'>;

const CASES: Record<Seat, Record<DecisionKey, Steelman>> = {
  A: {
    positioning: {
      strongestCase: '「下班后 15 分钟家常菜」一句话说清给谁、省什么，和你自己下班做饭的经历完全一致，观众一看就知道这个号能帮到自己什么。',
      strongestAlternative: '改成「一个人也要好好吃饭」，情绪更强、更容易被转发，但选题会变散，难以持续更新。',
      basis: '报告第 1 章写你每天 19 点到家、只有一个小时空闲；第 2 章的定位正好对应这个真实场景。',
    },
    audience: {
      strongestCase: '刚独居的上班族痛点集中：下班累、不会配菜、怕浪费，和你的内容能力正好对上。',
      strongestAlternative: '主攻双职工家庭的做饭人，他们更愿意为省时间付钱，但你目前没有家庭场景的素材。',
      basis: '第 4 章受众画像和第 1 章你的经历是同一类人，你说的话他们会信。',
    },
    platform: {
      strongestCase: '小红书的菜谱靠搜索被找到，收藏就是需求，新号也有机会。',
      strongestAlternative: '主平台改为抖音：做饭过程天然适合竖屏视频，能放大你已有的手机拍摄习惯，起量更快。',
      basis: '第 6 章提到你平时用手机竖拍做饭过程；抖音对完整过程视频的推荐更积极，我认为值得换成主平台。',
    },
    monetization: {
      strongestCase: '先接厨具和半成品品牌合作，门槛低，和内容场景贴合，不用另做产品。',
      strongestAlternative: '先卖付费周菜单，利润更高、更可控，但需要先证明有人愿意付钱。',
      basis: '第 10 章的品牌合作和内容场景最贴；一个人做号，先不要背上做产品的负担。',
    },
  },
  B: {
    positioning: {
      strongestCase: '「15 分钟」是可验证的承诺，观众看完一条就知道你有没有做到，信任来得快。',
      strongestAlternative: '定位成「上班族一周备餐」，单条内容更长，但更适合做系列和合集。',
      basis: '第 2 章的承诺可以被每条视频直接验证，这是同类账号里少见的。',
    },
    audience: {
      strongestCase: '独居上班族每天都要面对晚饭问题，需求天天发生，内容不愁没人看。',
      strongestAlternative: '把健身新手并进核心受众，他们更愿意收藏和照做，但会让菜谱方向两头拉扯。',
      basis: '第 4 章的人群每天都有同样的问题，选题来源稳定。',
    },
    platform: {
      strongestCase: '小红书用户会主动搜「快手晚饭」，你的标题天然能接住这种搜索。',
      strongestAlternative: '同时做小红书和视频号，覆盖更多家庭用户，但一个人很难两边都顾好。',
      basis: '第 6 章选择小红书的理由是搜索，这和第 2 章「15 分钟」的标题写法一致。',
    },
    monetization: {
      strongestCase: '品牌合作不需要你先搭产品，内容做好自然会有人来谈。',
      strongestAlternative: '先做免费周菜单收集愿意付钱的人，再推出付费版，比等品牌找上门更早拿到收入。',
      basis: '第 10 章写你希望三个月内验证能不能赚钱；只等品牌合作做不到这一点，所以我主张改。',
    },
  },
  C: {
    positioning: {
      strongestCase: '定位把「快」和「家常」放在一起，同类账号里少见，容易被记住。',
      strongestAlternative: '强调「零失败」而不是「快」，更照顾新手，但和很多教学号撞车。',
      basis: '第 5 章列出的同类账号都在讲「好吃」或「精致」，没有人主打下班后的速度。',
    },
    audience: {
      strongestCase: '受众描述和你的生活状态一致，你说的话他们会信。',
      strongestAlternative: '先服务健身新手，需求更明确，但你不是健身博主，信任要从头建立。',
      basis: '第 4 章正文和第 1 章一致，只是附录的健身人群需要清理。',
    },
    platform: {
      strongestCase: '新号最需要的是被搜到，小红书的搜索流量最稳定。',
      strongestAlternative: '主做 YouTube 中文频道，长视频更容易建立信任，但更新节奏会慢很多。',
      basis: '第 6 章和第 12 章的更新节奏都是按图文和短视频安排的，换平台要重排全部计划。',
    },
    monetization: {
      strongestCase: '品牌合作和你的内容场景最贴，不会让观众觉得突然在卖东西。',
      strongestAlternative: '先用免费周菜单测试付费意愿，有了真实反馈再定付费产品的价格和形式。',
      basis: '第 10 章的价格区间没有任何依据；先测付费意愿，比先接合作更能说明这个号值不值得继续投入。',
    },
  },
};

export const VERDICTS_SPLIT: Record<Seat, Record<DecisionKey, Verdict>> = {
  A: { positioning: 'keep', audience: 'keep', platform: 'change', monetization: 'keep' },
  B: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  C: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
};
export const VERDICTS_AGREED: Record<Seat, Record<DecisionKey, Verdict>> = {
  A: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  B: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  C: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
};
/** After round 2 of the split review: A was persuaded on monetization and still wants to change the platform. */
export const VERDICTS_ROUND_TWO: Record<Seat, Record<DecisionKey, Verdict>> = {
  A: { positioning: 'keep', audience: 'keep', platform: 'change', monetization: 'change' },
  B: VERDICTS_SPLIT.B,
  C: VERDICTS_SPLIT.C,
};

export function decisionsOf(seat: Seat, verdicts: Record<Seat, Record<DecisionKey, Verdict>>): DetailDecision[] {
  return (['positioning', 'audience', 'platform', 'monetization'] as const)
    .map(decision => ({ decision, ...CASES[seat][decision], verdict: verdicts[seat][decision] }));
}

export const ISSUES: Record<Seat, DetailIssue[]> = {
  A: [
    { location: '第 12 章 30 天行动', perspective: SELF, severity: 'critical',
      problem: '前两周要求每天更新，和你在第 1 章写的「每天只有晚上一小时空闲」直接冲突。一条 15 分钟菜谱从买菜、备菜、拍摄到剪辑，'
        + '按你现在的熟练程度至少要两个小时，每天更新意味着每晚都要熬夜。按这个强度，第二周最容易断更，'
        + '而新号断更后很难再把节奏找回来，前面积累的推荐也会跟着变少。',
      suggestion: '改为每周三更（周二、周四、周日），周末集中拍两条备用；前两周先把节奏跑稳，第三周起看精力再决定要不要加到每周五更。' },
    { location: '第 4 章 受众画像', perspective: AUDIENCE_SOLO, severity: 'major',
      problem: '画像只写了年龄和城市，没写他们几点到家、厨房里有什么、为什么经常放弃做饭。选题如果不对应这些具体场景，就会变成泛泛的菜谱。',
      suggestion: '补上三项：到家时间（多数在 19–20 点）、厨房条件（单灶、小冰箱、没有烤箱）、最常放弃做饭的原因（太累、买菜麻烦、一个人吃不完），'
        + '之后每条选题都对应其中一个场景。' },
    { location: '第 9 章 内容支柱', perspective: SELF, severity: 'minor',
      problem: '「厨房好物」这个支柱和主题关系弱，做多了容易变成带货号，削弱「15 分钟」的承诺。',
      suggestion: '把这个支柱改成「备菜和收纳」，让每条内容仍然服务于「快」。' },
  ],
  B: [
    { location: '第 10 章 变现路径', perspective: SELF, severity: 'critical',
      problem: '品牌合作要等账号有一定规模才会来，前三个月几乎没有收入来源，和你在第 10 章写的「三个月内验证能不能赚钱」不符。',
      suggestion: '第一个月就上线免费周菜单，用报名表收集愿意付钱的人；第三个月按报名情况决定要不要推出付费版，品牌合作放到第二步。' },
    { location: '第 6 章 平台选择', perspective: AUDIENCE_FAMILY, severity: 'major',
      problem: '双职工家庭更常在视频号和抖音找菜谱，只做小红书会漏掉他们。',
      suggestion: '主平台不变，把同一条视频同步到抖音，观察家庭用户的反馈再决定要不要加重。' },
    { location: '第 2 章 定位一句话', perspective: AUDIENCE_FIT, severity: 'minor',
      problem: '「家常菜」容易让人以为偏油偏咸，在意饮食的人可能直接划走。',
      suggestion: '在账号简介里写明少油少盐，定位一句话保持不变。' },
  ],
  C: [
    { location: '第 4 章 受众画像', perspective: AUDIENCE_FIT, severity: 'major',
      problem: '健身新手只在附录出现一次，正文却把他们算进核心受众，前后不一致，会让选题在「快」和「健康」之间摇摆。',
      suggestion: '把健身新手移出核心受众，放进「以后可以扩展的人群」，等账号稳定后再考虑专门的系列。' },
    { location: '第 12 章 30 天行动', perspective: AUDIENCE_SOLO, severity: 'major',
      problem: '行动计划没有安排在评论区收集问题，错过了最省力、也最贴近受众的选题来源。',
      suggestion: '每周日固定花二十分钟整理评论区问题，挑一到两个排进下周选题，并在视频开头说明「这是评论区问的」。' },
    { location: '第 10 章 变现路径', perspective: SELF, severity: 'major',
      problem: '付费食谱的价格区间没有依据，现在定价容易定错，也会让你过早把精力放到做产品上。',
      suggestion: '删掉价格区间，先用免费周菜单的报名情况判断付费意愿，再定价格和形式。' },
    { location: '第 3 章 差异化', perspective: AUDIENCE_FAMILY, severity: 'minor',
      problem: '和同类账号的区别只写了「更快」，没说清快在备菜、烹饪还是收拾，观众很难记住。',
      suggestion: '写明快在备菜：周日一次切配，工作日三天复用。' },
  ],
};

export const RESPONSES: Record<Seat, DetailResponse[]> = {
  A: [
    { reviewer: 'B', decision: 'monetization', stance: 'agree',
      strongestView: 'B 认为品牌合作要等规模，前三个月没有收入；先做免费周菜单能更早验证有没有人愿意付钱。',
      reason: '我原来担心做产品分散精力，但周菜单只是一张表和一份菜单，不算真正的产品。这一点我被说服了，改为支持先做周菜单。' },
    { reviewer: 'C', decision: 'platform', stance: 'disagree',
      strongestView: 'C 认为新号最需要的是被搜到，而不是被推荐，小红书的搜索流量最稳定，换平台还要重排全部计划。',
      reason: '搜索确实稳定，但做饭过程视频在抖音更容易被推荐给不认识你的人。我仍然主张抖音为主，至少应该同步发布。' },
  ],
  B: [
    { reviewer: 'A', decision: 'platform', stance: 'disagree',
      strongestView: 'A 认为做饭过程天然适合竖屏视频，抖音能放大你已有的拍摄习惯，起量更快。',
      reason: '起量快不等于留得住；你的标题写法是为搜索设计的，换到抖音要重新学一套。我仍然支持小红书为主。' },
  ],
  C: [
    { reviewer: 'A', decision: 'monetization', stance: 'disagree',
      strongestView: 'A 认为品牌合作门槛最低、和内容场景最贴，不需要另外搭一个付费产品。',
      reason: '门槛低是事实，但它回答不了「有没有人愿意为你付钱」这个问题。我仍然主张先做周菜单。' },
  ],
};
