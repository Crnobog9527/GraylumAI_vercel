/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Sample J's merged module (Owner 2026-10-15): "这些事，不用你再操心" (five demos of what the coach does for you) and
 * "定位之后，它接着陪你做内容" (library, voice, publishing; the weekly review lives in "不用自己看数据"). Sample H's
 * layout: the list on the left, the real product in the middle, what this screen shows on the right. The demo's
 * made-up case (a dental assistant in Canada), labelled 示例; no figures, no promise of income. NEW WORDING except the
 * titles marked OWNER / FINAL.
 */
export type WorkId = 'topics' | 'method' | 'data' | 'money' | 'models' | 'library' | 'voice' | 'publish';
export type WorkScene = {
  id: WorkId; group: 0 | 1; title: string; did: string; result: string; phases: number; needs: readonly LandingFeature[];
};

export const J_WORK = {
  /** OWNER (the 3c title, moved here) and FINAL (the scenes' title). */
  groups: ['这些事，不用你再操心', '定位之后，它接着陪你做内容'],
  /** FINAL (HOW_IT_WORKS.promise's last line), verbatim. */
  close: '拍摄、出镜、录音这些要你本人来，其余交给它。',
  lede: '下面是示例：人物和内容为虚构，界面是真实产品的界面。',
  rightLabel: '这一屏在做什么',
  resultLabel: '用了之后',
  next: '下一个',
} as const;

export const J_WORK_SCENES: readonly WorkScene[] = [
  {
    id: 'topics', group: 0, title: '不用自己想选题', phases: 4, needs: ['content'],
    did: '你问一句"下周发什么"，它按你确认过的定位排出下周三条选题，每条写清为什么选它；你点"采用"，选题就进了资料库。',
    result: '每周打开就有排好的选题，不用再对着空白页发愁，也不会越做越偏离定位。',
  },
  {
    id: 'method', group: 0, title: '不用研究运营技术', phases: 4, needs: ['coach'],
    did: '它直接给出这一条的具体做法：账号简介怎么写、开头怎么拍、标题怎么起。都是针对你这条内容的，不是一篇通用教程。',
    result: '平台规则和拍摄、写作技巧不用自己去学，照着做就能发出一条像样的内容。',
  },
  {
    id: 'data', group: 0, title: '不用自己看数据', phases: 4, needs: ['publish', 'coach'],
    did: '它读取你这周真实发出去的内容和平台数据，结合你的定位和选题一起分析：哪条有效、为什么、下周怎么调。',
    result: '不用自己盯后台、猜原因，每周都知道下一步该改什么。',
  },
  {
    id: 'money', group: 0, title: '不用为变现发愁', phases: 3, needs: ['report'],
    did: '定位报告里有一章变现路线：它先判断这个方向能不能赚钱、靠什么赚，再按先后写出适合你的路径。这是判断和建议，不是收入承诺。',
    result: '一开始就知道这个账号往哪里变现，不用做了半年才发现方向赚不到钱。',
  },
  {
    id: 'models', group: 0, title: '不用研究模型和提示词', phases: 4, needs: ['coach'],
    did: '你只说一句要做什么，它自己读你的资料、选好合适的能力，把事情做完。用哪个模型、提示词怎么写，都不用你管。',
    result: '不用在好几个 AI 工具之间来回切换，也不用学怎么写提示词。',
  },
  {
    id: 'library', group: 1, title: '资料库，它记得你', phases: 3, needs: ['library'],
    did: '你采用的选题、写好的稿件和当前定位，都按平台和账号存在资料库里。下次开新对话，它直接接着用。',
    result: '换一个对话窗口也不用重新介绍自己，做到哪里都接得上。',
  },
  {
    id: 'voice', group: 1, title: '按你的文风写', phases: 4, needs: ['voice'],
    did: '把你以前写的文章，用途选"我本人写的"上传。它读完总结出你的文风，之后写的每条稿子都照着这个来。',
    result: '写出来的稿子像你自己会说的话，不是千篇一律的 AI 腔。',
  },
  {
    id: 'publish', group: 1, title: '一次发到多个平台', phases: 3, needs: ['publish'],
    did: '稿子定了，选好要发的平台，确认后一次发出；发出去的内容自动在资料库里记为已发布。',
    result: '不用把同一条内容复制到每个平台各发一遍。',
  },
];

/** The sample content inside the windows. */
export const J_WORK_SAMPLES = {
  topics: {
    ask: '下周发什么？',
    reply: '按你的定位，下周排三条，从浅到深：',
    items: [
      { title: '入行前要准备哪些证书', why: '想入行的人最先搜的问题，适合打开局面' },
      { title: '课程怎么选：我当时踩过的坑', why: '你亲身走过的路，别人替代不了' },
      { title: '第一份工作的面试会问什么', why: '离"找到工作"最近的一步，最容易被收藏' },
    ],
    adopt: '采用这三条',
    adopted: '已采用，已放进资料库',
  },
  method: {
    ask: '第二条怎么拍？',
    reply: '这一条按下面做：',
    rows: [
      ['账号简介', '在加拿大做牙科助理 · 分享从零入行的真实路径'],
      ['开头怎么拍', '第一句就说结论："选课先看有没有实习"；手机放在胸口高度，直接对着镜头说'],
      ['中间怎么讲', '只讲你自己踩过的一个坑，再给三条判断方法，每条一句话'],
      ['标题怎么起', '用"我当时……"开头，写清你帮观众省掉的那件事'],
    ],
  },
  data: {
    ask: '看看这周发的效果。',
    fetching: ['读取 TikTok 账号数据', '读取 Instagram 账号数据', '对照你的定位和这周的选题'],
    title: '本周复盘',
    trend: '这周的互动走势',
    rows: [
      ['哪条有效', '讲证书清单的那条，收藏和提问最多'],
      ['为什么', '内容具体，看完就能照着做，正好是你定位里"想入行的新移民"要的'],
      ['下周怎么调', '多做"清单 + 你的亲身经历"，每周至少一条'],
    ],
  },
  money: {
    title: '定位报告（示例）',
    chapter: '变现路线',
    verdict: '这个方向能变现，但不靠流量广告，靠你能提供的具体帮助。',
    routes: [
      { step: '先', text: '用免费内容建立信任，评论区答疑' },
      { step: '再', text: '提供一对一入行咨询' },
      { step: '之后', text: '把经验整理成入行指南' },
    ],
    note: '这是根据你的定位做的判断和建议，不代表收入承诺。',
  },
  models: {
    ask: '帮我把这条稿子改得更口语一点，再出三个标题。',
    steps: ['读取你的文风画像', '读取资料库里的这条稿子', '选好写作和起标题的能力', '完成'],
    reply: '改好了。三个标题：',
    titles: ['我当年选课多花的冤枉钱，你别再花', '在加拿大做牙助，选课先看这一条', '转行牙科助理，课程别只看价格'],
  },
  library: {
    intro: '按平台和账号查看已采用选题、稿件和当前定位。',
    account: { platform: 'TikTok', name: '牙助阿杰的转行笔记' },
    items: [
      { title: '课程怎么选：我当时踩过的坑', type: '口播稿', draft: '刚采用', published: '未发布', fresh: true },
      { title: '入行前要准备哪些证书', type: '口播稿', draft: '已定稿', published: '已发布', fresh: false },
      { title: '我是怎么在加拿大入行的', type: '口播稿', draft: '已定稿', published: '已发布', fresh: false },
    ],
    chat: '新对话：接着写第二条。',
    reply: '好，接着写"课程怎么选"。你的定位和文风我都记着。',
  },
  voice: {
    files: ['我以前写的入行经历.txt', '小红书旧帖合集.md'],
    title: '你的文风画像',
    rows: [
      ['句子', '短句多，一句只说一件事'],
      ['口吻', '像跟朋友聊天，常用"你"'],
      ['习惯', '先讲自己的经历，再讲方法'],
    ],
    before: '选择课程时，应综合考虑课程内容、实习机会及价格等多方面因素。',
    after: '我当年选课，只看了价格。结果没实习，找工作吃了大亏。你别学我。',
    beforeLabel: '一般 AI 的写法',
    afterLabel: '按你的文风',
  },
  publish: {
    post: '课程怎么选：我当时踩过的坑',
    platforms: [
      { name: 'TikTok', on: true },
      { name: 'Instagram', on: true },
      { name: 'YouTube', on: true },
      { name: 'Facebook', on: false },
    ],
    action: '确认发出',
    done: '已发出，已在资料库记为已发布',
  },
} as const;
