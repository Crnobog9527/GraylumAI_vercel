/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../article';
import { SIGNUP_CTA_HREF } from './shared';

// The tutorial blog (SEO_GEO_SPEC 14; the header's 教程 menu is this page): articles are files in the repository, no CMS.
// The two articles below are the starter framework (PUBLIC-SITE, Owner 2026-10-17): they describe only how the product
// works today and give general advice. They carry no figures, results or user stories; the Owner adds the wording later.
export const BLOG_PATH = '/blog';
const CRUMBS = [{ name: '首页', path: '/' }, { name: '教程', path: BLOG_PATH }];

export const BLOG_POSTS: ArticleContent[] = [
  {
    locale: 'zh-Hans',
    path: '/blog/first-positioning-conversation',
    metaTitle: '第一次做账号定位：和 AI 教练的第一场对话',
    metaDescription: '第一次用 Graylum 做账号定位，要准备什么、会被问到什么、聊完能得到什么？这篇教程按三个步骤带你走一遍，让你在开始之前就大致知道这场对话会怎么进行、需要你做什么。',
    breadcrumb: [...CRUMBS, { name: '第一场定位对话', path: '/blog/first-positioning-conversation' }],
    h1: '第一次做账号定位：和 AI 教练的第一场对话',
    lead: '定位分析是三步对话：了解你，诊断与平台对标，定位与执行方案。你不用提前准备材料，照实回答教练的问题就行。',
    keyPoints: [
      '不需要提前写好方案，从你现在的真实情况聊起。',
      '聊到的信息会自动记进右侧清单，每一步由你核对确认一次。',
      '三步走完可以生成一份定位与执行方案报告。',
    ],
    cta: { label: '免费和教练聊聊', description: '想试试？注册后就能免费开始定位分析。', href: SIGNUP_CTA_HREF },
    sections: [
      {
        h2: '开始之前，需要准备什么？',
        paragraphs: ['不需要准备材料。想一想这几件事会让对话更顺：你做账号最想得到什么，每周大概能拿出多少时间，手上有没有可以作为内容素材的经验或作品。想不清楚也没关系，教练会一个一个问。'],
      },
      {
        h2: '第一步“了解你”会聊什么？',
        paragraphs: ['教练先问你的最终目标和变现方式、想吸引的人、可投入的资源。你回答之后，这些信息会被记到右侧的定位清单里，你可以随时修改。'],
      },
      {
        h2: '第二步和第三步',
        paragraphs: ['第二步“诊断与平台对标”结合你的情况判断适合先做哪个平台，并参考同领域做得好的账号。第三步“定位与执行方案”把前面确认过的内容整理成账号定位和后续安排。'],
      },
      {
        h2: '聊完之后会得到什么？',
        paragraphs: ['三步确认完，可以生成一份按章节阅读的定位与执行方案报告。报告属于付费会员功能，对话本身可以免费开始，具体权益见价格页。'],
      },
    ],
    related: [
      { label: '定位分析功能介绍', href: '/features/positioning', description: '看看定位分析的真实界面和每一步在做什么。' },
      { label: '开始发内容之前先做好这五件事', href: '/blog/before-you-start-posting', description: '下一篇：开始发内容前的准备。' },
    ],
    updated: '2026-10-17',
    published: '2026-10-17',
  },
  {
    locale: 'zh-Hans',
    path: '/blog/before-you-start-posting',
    metaTitle: '开始发内容之前，先做好这五件事',
    metaDescription: '很多人还没想清楚就开始拍和发，做了一阵不知道问题出在哪。这篇教程整理了开始发内容之前值得先想清楚的五件事：目标、受众、平台、节奏和复盘方式。',
    breadcrumb: [...CRUMBS, { name: '开始发内容之前', path: '/blog/before-you-start-posting' }],
    h1: '开始发内容之前，先做好这五件事',
    lead: '开始发内容之前，先想清楚五件事：做账号的目标、想吸引的人、先做哪个平台、能维持的更新节奏，以及之后怎么复盘。',
    keyPoints: ['目标和受众先于平台。', '选一个能长期维持的节奏。', '提前想好之后看什么、怎么调。'],
    definition: {
      term: '开始之前先想清楚什么？',
      text: '开始发内容之前，建议先把目标、受众、平台、更新节奏和复盘方式定下来。它们不需要一次定到完美，但有了第一版，之后每一次调整都有依据。',
    },
    cta: { label: '免费和教练聊聊', description: '这五件事想不清楚？定位分析会用对话带你逐项理清。', href: SIGNUP_CTA_HREF },
    sections: [
      { h2: '1. 你做这个账号想得到什么？', paragraphs: ['是接到客户、卖出产品、积累个人品牌，还是先单纯分享？目标不同，内容和平台的选法都不同。把它写成一句话。'] },
      { h2: '2. 你想吸引谁？', paragraphs: ['“所有人”无法写内容。试着描述一个具体的人：他在做什么、遇到什么问题、会在哪里找答案。'] },
      { h2: '3. 先做哪个平台？', paragraphs: ['先选一个和你的内容形式、受众都合得来的平台，做稳之后再延伸。同时开好几个平台，常常是每个都做不好。'] },
      { h2: '4. 能维持什么样的节奏？', paragraphs: ['按你每周真实能拿出的时间定节奏，而不是按理想状态。稳定地更新，比偶尔爆发更有价值。'] },
      { h2: '5. 之后怎么复盘？', paragraphs: ['提前决定每隔多久看一次数据、看哪几项，以及什么情况下调整方向。没有复盘，就只是在重复。'] },
    ],
    related: [
      { label: '第一次做账号定位：和 AI 教练的第一场对话', href: '/blog/first-positioning-conversation', description: '上一篇：定位分析的三步怎么走。' },
      { label: '选题与创作功能介绍', href: '/features/content', description: '定位确认后，每周发什么、怎么写。' },
    ],
    updated: '2026-10-17',
    published: '2026-10-17',
  },
];

export function findPost(slug: string): ArticleContent | undefined {
  return BLOG_POSTS.find(post => post.path === `${BLOG_PATH}/${slug}`);
}

export const BLOG_INDEX = {
  path: BLOG_PATH,
  metaTitle: '教程：怎么用 AI 教练做账号',
  metaDescription: 'Graylum 教程集中放在这里：第一次做账号定位怎么聊，开始发内容之前要想清楚什么，以及每个功能怎么用。文章会持续补充，内容只写产品已经有的功能，不夸大、不编造数据。',
  h1: 'Graylum 教程',
  lead: '这里放的是怎么用 AI 教练做账号的教程：先从定位开始，再到选题、写稿和复盘。文章会陆续补充。',
  breadcrumb: CRUMBS.slice(0, 2),
  updated: '2026-10-17',
};
