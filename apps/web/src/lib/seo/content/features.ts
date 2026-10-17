/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../article';
import { landingFaq } from './landing-faq-pick';
import { SIGNUP_CTA_HREF } from './shared';

// Product feature pages under /features (PUBLIC-SITE; Owner 2026-10-17: the formal landing is built as the full
// launch version). Each page shows the product's own display components with the shared example data, so the text
// below only describes what the product does today (SEO_GEO_SPEC 1.5 and 7.7): no prices, no promised quantities, no
// user cases. The product is called "AI 教练" everywhere (Owner 2026-10-17).
export const FEATURES_PATH = '/features';
const CRUMBS = [{ name: '首页', path: '/' }, { name: '功能介绍', path: FEATURES_PATH }];
const UPDATED = '2026-10-17';

export type FeatureSlug = 'positioning' | 'content' | 'jury' | 'library' | 'publish' | 'review';

/** Pages without a product screen yet (the product has no display component for them); text only until one exists. */
export const TEXT_ONLY_FEATURES: readonly FeatureSlug[] = ['publish', 'review'];

export type FeatureEntry = {
  slug: FeatureSlug;
  /** Menu label (the landing header's 产品 menu uses the same words). */
  name: string;
  note: string;
  content: ArticleContent;
};

const featurePath = (slug: FeatureSlug) => `${FEATURES_PATH}/${slug}`;

function cta(description: string, label = '免费和教练聊聊'): ArticleContent['cta'] {
  return { label, description, href: SIGNUP_CTA_HREF };
}

const POSITIONING: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('positioning'),
  metaTitle: '账号定位分析：对话里把方向想清楚',
  metaDescription: '不知道账号该做什么、做给谁看？Graylum 的 AI 教练用对话一步步问清你的情况，边聊边记成清单，每一步由你确认，最后整理成一份定位与执行方案报告。免费开始。',
  breadcrumb: [...CRUMBS, { name: '定位分析', path: featurePath('positioning') }],
  h1: '账号定位分析：先弄清做什么、给谁看、靠什么赚钱',
  lead: '定位分析是 AI 教练分三步带你想清楚账号做什么、给谁看，适合想做自媒体的新手，注册免费开始。',
  keyPoints: [
    '全程同一个对话，不用在表单和页面之间来回切换。',
    '聊到的信息自动记进右侧清单；每一步齐了以后，由你核对并确认一次。',
    '最后整理成一份可以照着执行的定位与执行方案报告。',
  ],
  definition: {
    term: '账号定位分析是什么？',
    text: '账号定位分析是在开始做内容之前，先想清楚三件事：你准备做给谁看、你能提供什么不一样的价值、这个账号靠什么变现。Graylum 把这件事做成 AI 教练和你的一场对话，而不是一张要你自己填的表。'
      + '和直接问通用 AI 不同，教练分三步主动提问，每一步由你确认，聊到的信息边聊边记成清单，最后整理成一份报告。它适合刚开始做自媒体的新手，以及有本职工作或小生意、没时间系统学运营的人。',
  },
  cta: cta('注册后就能免费开始定位分析：AI 教练先问你的目标和现有条件，你照实回答就行。'),
  sections: [
    {
      h2: '定位分析分哪几步？',
      paragraphs: ['整个过程是同一个对话，分成三步，每一步有各自的清单：'],
      subsections: [
        { h3: '第一步：了解你', paragraphs: ['教练先问你的最终目标、想吸引的人、手上有哪些时间和资源，把你的真实情况弄清楚，而不是让你直接选一个赛道。'] },
        { h3: '第二步：诊断与平台对标', paragraphs: ['结合你的情况判断适合先做哪个平台，并去看同领域做得好的账号，把别人的做法作为参考。'] },
        { h3: '第三步：定位与执行方案', paragraphs: ['把前两步确认过的内容整理成账号定位、内容方向和后续的执行安排。'] },
      ],
    },
    {
      h2: '为什么要边聊边记成清单？',
      paragraphs: [
        '对话里的信息容易散。AI 教练会把你聊到的内容记进右侧的定位清单，并标出哪些是从对话里记下的、哪些是教练的建议、哪些你已经确认。',
        '每一步需要的信息齐了以后，由你核对并确认一次，确认之前不会算数。哪里不对，改清单就行。',
      ],
    },
    {
      h2: '最后会得到什么？',
      paragraphs: [
        '三步走完，可以生成一份定位与执行方案报告，把现状、目标、受众、平台选择、对标账号、账号定位、内容规划和变现路径等整理到一起，按章节阅读。',
        '报告属于付费会员功能；定位分析的对话本身可以免费开始。具体权益以价格页为准。',
      ],
    },
    {
      h2: '适合谁用？',
      paragraphs: ['还没开始做账号、或者做了一阵子不确定方向对不对的个人和小团队：做内容的上班族、自由职业者、小店老板、想把专业知识做成内容的人。AI 教练会按你的实际情况提问，不要求你先懂运营。'],
    },
  ],
  faq: [
    { question: '定位分析要准备什么材料吗？', answer: '不需要。从对话开始，教练会问你需要回答的问题。' },
    { question: '聊到一半可以换窗口或者以后再继续吗？', answer: '可以。对话和清单都保存着，回来接着聊，不用重新讲一遍。' },
    { question: '清单里记错了怎么办？', answer: '直接在右侧改。每一步只有在你核对并确认之后才算数。' },
    ...landingFaq('faq-1', 'faq-2', 'faq-6'),
  ],
  related: [
    { label: '选题与创作', href: featurePath('content'), description: '定位确认后，每周怎么选题、怎么写稿。' },
    { label: '评审团', href: featurePath('jury'), description: '把报告交给几位评审各审一遍。' },
    { label: '资料库', href: featurePath('library'), description: '把你的文章和参考资料放进来，让教练按你的情况回答。' },
  ],
  updated: UPDATED,
  product: true,
};

const CONTENT: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('content'),
  metaTitle: '选题与创作：每周发什么，AI 教练帮你写',
  metaDescription: '定位清楚之后，每周发什么、怎么写？Graylum 的 AI 教练按你的定位和文风，和你商量选题，写出口播稿、贴文和分镜建议，每一版都保留，由你决定用哪一版。免费开始。',
  breadcrumb: [...CRUMBS, { name: '选题与创作', path: featurePath('content') }],
  h1: '选题与创作：每周发什么，一起商量，再写出来',
  lead: '选题与创作是定位确认后的日常工作：AI 教练和你商量每周发什么，再按你确认的定位和文风写稿，适合没时间系统学运营的人。',
  keyPoints: [
    '选题和写稿在同一个对话里完成，教练的建议你可以采纳，也可以改。',
    '写出来的稿件按版本保留，随时回看和对比。',
    '视频类选题还会附上分镜与剪辑建议。',
  ],
  definition: {
    term: '选题与创作是什么？',
    text: '选题与创作是 Graylum 的日常内容工作区：教练根据你已确认的账号定位，和你商量接下来发什么，再把确定的选题写成可以直接发布的稿件，例如口播稿、贴文文案和分镜建议。'
      + '和直接让通用 AI 写稿不同，教练写之前已经有你确认过的定位，每一版稿子都保留，可以随时回看。它适合想持续更新、又没时间系统学运营的人。',
  },
  cta: cta('从定位分析开始，确认定位之后就可以让教练和你一起排选题、写稿。'),
  sections: [
    {
      h2: '选题是怎么商量出来的？',
      paragraphs: [
        '你说想法，教练给出建议稿，你可以直接用，也可以让它改。对话按日期记录，哪条建议被你采纳、哪条完成了，都看得出来。',
        '建议建立在你已经确认的定位之上，所以不是一张谁都能拿去用的通用清单。',
      ],
    },
    {
      h2: '稿子怎么写出来？',
      paragraphs: ['选题定下来以后，教练按你的定位和说话习惯写出正文稿件；视频类的选题还会给出分镜与剪辑建议。每次修改都生成新的一版，旧版本不会丢。'],
      list: ['正文稿件：口播稿或贴文文案。', '分镜与剪辑建议：每个镜头讲什么、怎么切。', '版本对比：看清这一版比上一版改了什么。'],
    },
    {
      h2: '写好的内容会存在哪里？',
      paragraphs: ['保存下来的成果会进入你的资料库，换窗口、换天也找得到。'],
    },
  ],
  faq: [
    { question: '一定要先做完定位分析吗？', answer: '建议先做。选题和写稿都以你确认过的定位为依据，定位没确认，建议会比较泛。' },
    { question: '稿子一定要用教练写的吗？', answer: '不用。你可以只用选题建议，自己写；也可以让教练写初稿再改。' },
    ...landingFaq('faq-3', 'faq-10'),
  ],
  related: [
    { label: '定位分析', href: featurePath('positioning'), description: '先弄清做什么、给谁看、靠什么赚钱。' },
    { label: '资料库', href: featurePath('library'), description: '保存成果，也让教练参考你以前写过的内容。' },
    { label: '评审团', href: featurePath('jury'), description: '重要的报告，再让几位评审审一遍。' },
  ],
  updated: UPDATED,
  product: true,
};

const JURY: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('jury'),
  metaTitle: '多模型评审团：几位评审各审一遍报告',
  metaDescription: 'Graylum 的评审团让多个大模型分别站在你的受众和你本人的角度审一遍定位报告：意见不一致就再辩一轮，最后汇总成修订稿，每一章用不用由你决定。Gold 会员功能。',
  breadcrumb: [...CRUMBS, { name: '评审团', path: featurePath('jury') }],
  h1: '多模型评审团：把报告交给几位评审各审一遍',
  lead: '评审团让几个不同的大模型分别审你的定位报告，有分歧再辩一轮，汇总成修订稿，每一章用不用由你定。',
  keyPoints: [
    '几位评审各自独立审阅，不会互相照抄。',
    '意见不一致时，评审会再辩一轮，再给出汇总意见。',
    '修订稿按章节给你选：每一章都可以决定采用修订还是保留原文。',
  ],
  definition: {
    term: '评审团是什么？',
    text: '评审团是 Graylum 的多模型评审功能：同一份定位报告交给几位评审（由不同的大模型担任），它们分别从受众视角、变现落地和内容策略等角度独立审阅，把分歧辩一轮后，由首席主笔汇总成修订稿。'
      + '它是 Gold 会员专属功能。和只问一个 AI 不同，几位评审各自独立审阅，意见不一致的地方会被摆出来再辩一轮，而不是被悄悄抹平。它适合想在定稿前多一道把关的人。',
  },
  cta: cta('评审团审的是定位分析生成的报告。先完成定位分析，报告出来之后就可以交给评审团。'),
  sections: [
    {
      h2: '评审团是怎么工作的？',
      paragraphs: ['一次评审分成几个阶段，上方的演示里可以看到每位评审的位置和说的话：'],
      list: [
        '入座和阅读：每位评审拿到同一份报告，各自读一遍。',
        '独立挑错：站在你的受众、你本人和落地执行的角度，各自写下意见。',
        '辩论：意见不一致的地方，评审之间再来回辩一轮。',
        '汇总：首席主笔把意见整理成一份修订稿。',
      ],
    },
    {
      h2: '为什么不是一个模型审一遍？',
      paragraphs: ['同一个模型审同一份报告，容易沿着自己的思路一路走下去。让几个不同的模型分别审，能互相发现对方漏掉的问题，而且意见不一致的地方会被摆到台面上，而不是被悄悄抹平。'],
    },
    {
      h2: '修订稿我必须全用吗？',
      paragraphs: [
        '不用。结果页把整份报告拆成易读的章节，每一章都能看到原文、修订和评审的理由，由你逐章决定采用修订还是保留原文。',
        '评审过程的工作记录也保留着，想看某位评审是怎么想的，随时可以点开。',
      ],
    },
    {
      h2: '评审要等多久？',
      paragraphs: ['开始之前，页面会告诉你这次评审大约需要多久；评审进行时，进度条和每位评审的状态一直显示着，你可以离开，回来接着看。'],
    },
  ],
  faq: [
    { question: '评审团是哪个会员等级的功能？', answer: '它是 Gold 会员专属功能。具体权益和价格以价格页为准。' },
    { question: '评审团会改我的原报告吗？', answer: '不会直接改。修订稿是单独一份，每一章用不用由你决定。' },
    { question: '评审团的演示是真实评审吗？', answer: '页面上的演示使用的是示例报告和示例评审名字，只用来说明评审是怎么进行的，不是某个真实用户的报告。' },
    ...landingFaq('faq-13'),
  ],
  related: [
    { label: '定位分析', href: featurePath('positioning'), description: '评审团审的报告就是从这里生成的。' },
    { label: '选题与创作', href: featurePath('content'), description: '定位确认后，每周发什么、怎么写。' },
    { label: '价格', href: '/landing/pricing', description: '各个会员等级包含的功能和价格。' },
  ],
  updated: UPDATED,
  product: true,
};

const LIBRARY: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('library'),
  metaTitle: '资料库：定位和资料都记着，换窗口也不忘',
  metaDescription: 'Graylum 的资料库让你把写过的文章、参考资料和教练写好的成果放在一起：上传时标明是本人写的还是参考资料，随时查看、下载和删除，空间用了多少一目了然。',
  breadcrumb: [...CRUMBS, { name: '资料库', path: featurePath('library') }],
  h1: '资料库：你的资料都放这里，换窗口也不用重讲',
  lead: '资料库放你写过的文章、参考资料和教练成果，换窗口、换天都找得到，适合资料和成果越攒越多的人。',
  keyPoints: [
    '上传文档和图片，并标明用途：“我本人写的”或“参考资料”。',
    '随时查看、下载和删除；页面上看得到已用空间和总空间。',
    '文件处理中、可用、失败，状态都写在列表里。',
  ],
  definition: {
    term: '资料库是什么？',
    text: '资料库是 Graylum 里属于你自己的文件空间：写过的文章、品牌介绍、客户常见问题等资料放在这里，教练写好并保存的成果也放在这里，换窗口、换天都找得到。和聊完就散的对话不同，资料和成果都存在你自己的空间里，随时查看、下载和删除。它适合文章、资料和成果越攒越多的内容创作者。',
  },
  cta: cta('注册后即可使用资料库，把写过的文章和参考资料放进来。'),
  sections: [
    {
      h2: '资料库里能放什么？',
      paragraphs: ['可以上传文本类文档和图片。每个文件上传时要选择用途，列表里按用途分开显示：'],
      list: [
        '我本人写的：你写过的文章、笔记。',
        '参考资料：品牌介绍、产品说明、行业资料。',
        '教练成果：你在选题与创作里保存下来的稿件。',
      ],
    },
    {
      h2: '空间和文件怎么管理？',
      paragraphs: [
        '页面上方显示已用空间和总空间；原文件和提取出的文字都计入空间。文件列表显示每个文件的用途、大小和状态，可以按用途筛选，查看、下载或删除。',
        '上传失败的文件会标出来，可以重试或移除；超出空间时，已有文件仍可查看、下载和删除。',
      ],
    },
    {
      h2: '我的资料会被怎么用？',
      paragraphs: ['资料库里的文件怎么处理，以隐私政策为准。想删除，随时可以在列表里删掉。'],
    },
  ],
  faq: [
    { question: '一个文件最大多少？', answer: '页面上传区会写明单个文件的大小上限，目前是不超过 10 MB；太大的文件请拆分后上传。' },
    { question: '删除文件后，空间会马上释放吗？', answer: '删除中的文件会显示“删除中，空间暂未释放”，完成后释放。' },
  ],
  related: [
    { label: '定位分析', href: featurePath('positioning'), description: '先弄清做什么、给谁看、靠什么赚钱。' },
    { label: '选题与创作', href: featurePath('content'), description: '保存下来的稿件会进入资料库。' },
  ],
  updated: UPDATED,
  product: true,
};

const PUBLISH: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('publish'),
  metaTitle: '发布排期：标题标签按平台改好，排进日历',
  metaDescription: 'Graylum 的发布排期帮你把写好的内容按平台改好标题和标签，排进日历，再发到你授权的账号。每个平台的写法不同，教练替你对着平台改，发布前由你确认。',
  breadcrumb: [...CRUMBS, { name: '发布排期', path: featurePath('publish') }],
  h1: '发布排期：写好的内容，按平台改好再排进日历',
  lead: '发布排期负责写完稿之后的最后一段：按平台改好标题和标签，排进日历，发到你授权的账号，适合想省下手动上稿时间的人。',
  keyPoints: [
    '同一份内容，按不同平台的习惯改好标题和标签。',
    '排进日历，一眼看清这周什么时候发什么。',
    '只发到你自己授权的账号，发布前由你确认。',
  ],
  definition: {
    term: '发布排期是什么？',
    text: '发布排期是写完稿之后的最后一段：教练按目标平台的习惯改好标题和标签，你确认后排进日历，再发到你自己授权的账号。和把同一份内容手动复制到各个平台不同，每个平台的写法在同一个地方改好、排好。它适合同时做几个平台、想省下手动上稿时间的人。',
  },
  cta: cta('从定位分析开始，选题和稿件有了，再来排发布。'),
  sections: [
    { h2: '为什么要按平台改标题和标签？', paragraphs: ['同一条内容在不同平台的标题长度、标签写法和发布习惯都不一样。发布排期把这件事交给教练，对着目标平台改好，你只需要看一眼确认。'] },
    { h2: '排期怎么用？', paragraphs: ['写好的稿件可以排进日历，选好平台和时间。日历上能看到已排好的内容，方便把一周的节奏排匀。'] },
    { h2: '发布到哪里？', paragraphs: ['只发布到你自己授权接入的账号，不会替你使用别人的账号；每次发布前由你确认内容。'] },
  ],
  faq: [
    { question: '发布排期和选题与创作是什么关系？', answer: '先在选题与创作里把稿件写好，再来这里按平台改好、排期和发布。' },
  ],
  related: [
    { label: '选题与创作', href: featurePath('content'), description: '先把每周发什么和稿件定下来。' },
    { label: '数据复盘', href: featurePath('review'), description: '发出去之后，看数据、调方向。' },
    { label: '定位分析', href: featurePath('positioning'), description: '先弄清做什么、给谁看、靠什么赚钱。' },
  ],
  updated: UPDATED,
  product: true,
};

const REVIEW: ArticleContent = {
  locale: 'zh-Hans',
  path: featurePath('review'),
  metaTitle: '数据复盘：读真实数据，告诉你下周怎么调',
  metaDescription: 'Graylum 的数据复盘读取你自己账号作品的真实数据，由 AI 教练告诉你哪些内容有效、哪些该调整，以及下周具体怎么改，让每周的内容越做越准，而不是凭感觉。',
  breadcrumb: [...CRUMBS, { name: '数据复盘', path: featurePath('review') }],
  h1: '数据复盘：读你自己的真实数据，告诉你下周怎么调',
  lead: '数据复盘读你自己账号作品的数据，由 AI 教练指出哪些内容有效、下周怎么调，适合发了一阵却不知道问题在哪的人。',
  keyPoints: [
    '用你自己作品的真实数据，不是行业平均数。',
    '告诉你哪些有效、哪些该调整。',
    '给出下一周具体怎么改的建议。',
  ],
  definition: {
    term: '数据复盘是什么？',
    text: '数据复盘是读取你自己账号作品的数据，由 AI 教练指出哪些内容有效、哪些该调整，并给出下一周具体怎么改。和泛泛的行业经验不同，它依据的是你自己的数据。它适合已经发了一阵内容、想知道问题出在哪的人。',
  },
  cta: cta('从定位分析开始，账号方向清楚了，复盘才有可比较的目标。'),
  sections: [
    { h2: '复盘读的是什么数据？', paragraphs: ['读的是你自己账号作品的数据，例如播放、互动等指标，而不是泛泛的行业数字。没有数据可读的平台，可以手动导入。'] },
    { h2: '复盘会告诉你什么？', paragraphs: ['教练对照你的账号定位，指出哪些内容表现好、哪些没达到预期，并解释可能的原因，再给出下周具体怎么调整。'] },
    { h2: '为什么要每周复盘？', paragraphs: ['固定节奏地看数据、改方向，比凭感觉连续发更容易发现问题。复盘结果也会成为下周选题的依据。'] },
  ],
  faq: [
    { question: '没有数据的新账号能复盘吗？', answer: '没有作品数据时先发内容；有了第一批数据，复盘才有东西可读。' },
  ],
  related: [
    { label: '发布排期', href: featurePath('publish'), description: '把内容按平台改好，排进日历。' },
    { label: '选题与创作', href: featurePath('content'), description: '复盘之后，下周发什么。' },
    { label: '定位分析', href: featurePath('positioning'), description: '先弄清做什么、给谁看、靠什么赚钱。' },
  ],
  updated: UPDATED,
  product: true,
};

export const FEATURES: FeatureEntry[] = [
  { slug: 'positioning', name: '定位分析', note: '先弄清做什么、给谁看、靠什么赚钱', content: POSITIONING },
  { slug: 'content', name: '选题与创作', note: '每周排好选题，按你的文风写稿', content: CONTENT },
  { slug: 'jury', name: '评审团', note: '几位评审各审一遍，写出修订稿', content: JURY },
  { slug: 'library', name: '资料库', note: '定位和资料都记着，换窗口也不忘', content: LIBRARY },
  { slug: 'publish', name: '发布排期', note: '标题标签按平台改好，排进日历', content: PUBLISH },
  { slug: 'review', name: '数据复盘', note: '读真实数据，告诉你下周怎么调', content: REVIEW },
];

export function findFeature(slug: string): FeatureEntry | undefined {
  return FEATURES.find(entry => entry.slug === slug);
}

export const FEATURES_HUB: ArticleContent = {
  locale: 'zh-Hans',
  path: FEATURES_PATH,
  metaTitle: '功能介绍：AI 教练陪你做自媒体',
  metaDescription: 'Graylum 是 AI 自媒体陪跑教练。这里介绍产品的主要功能：定位分析、选题与创作、评审团、资料库、发布排期和数据复盘，已有界面的功能都配有真实产品界面的示例。',
  breadcrumb: [{ name: '首页', path: '/' }, { name: '功能介绍', path: FEATURES_PATH }],
  h1: 'Graylum 功能介绍：AI 教练在每一步怎么帮你',
  lead: 'Graylum 是 AI 自媒体陪跑教练，在同一个对话式工作区里帮你做定位、选题写稿、评审报告和管理资料，适合想做自媒体的新手。',
  keyPoints: [
    '定位分析：三步对话，边聊边记成清单。',
    '选题与创作：商量选题，按你的文风写稿。',
    '评审团：几位评审各审一遍，写出修订稿。',
    '资料库：你的文章、资料和成果，放在一起管理。',
    '发布排期：按平台改好标题标签，排进日历。',
    '数据复盘：读真实数据，告诉你下周怎么调。',
  ],
  definition: {
    term: 'Graylum 是什么？',
    text: 'Graylum 是 AI 自媒体陪跑教练，在同一个对话式工作区里帮你完成定位、选题写稿、报告评审和资料管理。和直接问通用 AI 不同，教练按步骤主动提问，每一步由你确认，并保留你确认过的定位。它适合刚开始做自媒体的新手，以及有本职工作或小生意、没时间系统学运营的人。',
  },
  cta: cta('不确定从哪一项开始？先做定位分析，免费开始。'),
  sections: [
    {
      h2: '主要功能一览',
      paragraphs: ['下面每一项都有单独的页面；已有产品界面的功能，页面里的界面都是真实产品的示例，用的是虚构的示例内容。'],
      subsections: FEATURES.map(entry => ({ h3: entry.name, paragraphs: [`${entry.note}。`] })),
    },
    {
      h2: '功能之间怎么配合？',
      paragraphs: ['典型的顺序是：先做定位分析，把方向确认下来；之后每周在选题与创作里排选题、写稿，在发布排期里按平台排好发布，再用数据复盘调整下一周；重要的报告可以交给评审团再审一遍；你的文章、资料和保存下来的成果放在资料库里，随时查看。'],
    },
    {
      h2: '页面上的界面是真的吗？',
      paragraphs: ['是。功能页里的界面用的是产品里同一批显示组件，只是内容换成了虚构的示例数据：示例里的账号、对话和文件都不是真实用户的。'],
    },
  ],
  faq: [...landingFaq('faq-1', 'faq-11')],
  related: FEATURES.map(entry => ({ label: entry.name, href: entry.content.path, description: entry.note })),
  updated: UPDATED,
  product: true,
};
