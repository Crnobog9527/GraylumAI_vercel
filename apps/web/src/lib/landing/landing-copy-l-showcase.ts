/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_WORK_MAKE } from './landing-copy-j-work-make';
import type { LandingFeature } from './landing-flags';
import { L_CARE } from './landing-copy-l';

/**
 * Sample L, under region 3: the library and writing in your own voice, told on their own (Owner 2026-10-17:
 * "'资料库'和'文风参考'这两个功能要拿出来着重讲一下，这两个功能是用户非常在意的"). The page's person (下班后 15 分钟家常菜).
 * Headings and the one line under each reuse region 5's approved worry and answer (L_CARE); steps reuse sample J's
 * approved library and voice wording (J_WORK_MAKE) where it exists. Everything else is NEW wording for the Owner to
 * judge on the page. Capabilities stay within docs/launch/MASTER_PLAN.md section 5 and tasks/LIBRARY-VOICE.md: two
 * purposes per file (我本人写的 / 参考资料), a voice profile the person checks, edits and confirms, used only while
 * "使用我的文风" is on. The materials, numbers and texts are the example's.
 */

/** Region 5's approved worry and answer for a capability (verbatim). */
function care(feature: LandingFeature) {
  const item = L_CARE.items.find(entry => entry.needs.includes(feature));
  if (!item) throw new Error(`L_CARE has no item for ${feature}`);
  return item;
}

const J_LIBRARY = J_WORK_MAKE.find(scene => scene.id === 'library')!;
const J_VOICE = J_WORK_MAKE.find(scene => scene.id === 'voice')!;

export type ShowcaseBeat = { label: string; line: string };

/** NEW: the block's heading and its one line. */
export const L_SHOWCASE = {
  title: '它记得你，也写得像你',
  lede: '你传上来的资料和写过的文字，AI 教练之后都会用上。',
} as const;

/** 资料库: heading and line are region 5's (approved); the steps' labels and lines are NEW unless marked. */
export const L_SHOWCASE_LIBRARY = {
  name: '资料库',
  title: care('library').worry,
  line: care('library').does,
  beats: [
    { label: '上传你的资料', line: '把写过的文章、产品介绍、以前发的帖子传进资料库，用途选"我本人写的"或"参考资料"。' },
    { label: '新对话里接着用', line: '换一个对话问它，它按你的定位和资料来回答，还写明用了哪份资料。' },
    /** Sample J's approved result line. */
    { label: '不用从头介绍自己', line: J_LIBRARY.result },
  ] as readonly ShowcaseBeat[],
  /** The documents in the library's "我的文档" (file names, purpose, size). */
  documents: [
    { filename: '以前发的做饭记录.txt', format: 'txt', purpose: 'authored', bytes: 18_400 },
    { filename: '小红书旧笔记.md', format: 'md', purpose: 'authored', bytes: 9_600 },
    { filename: '我常用的厨具清单.md', format: 'md', purpose: 'reference', bytes: 3_200 },
    { filename: '一周菜单和备菜指南介绍.md', format: 'md', purpose: 'reference', bytes: 5_800 },
  ] as const,
  /** Step 2: a new conversation answered from the positioning and one reference file. */
  ask: {
    user: '朋友总问我用什么锅，想拍一条讲我的厨具，帮我起个头。',
    coach: [
      '你在《我常用的厨具清单》里写过，平时只用一口不粘锅和一把小刀，正好接上你的定位"下班后 15 分钟上桌"。开头可以这样：',
      '"我做饭只用一口锅。十五分钟，两菜一汤，洗碗也只洗这一口。"',
    ],
    sources: ['当前定位', '我常用的厨具清单.md'],
  },
  /** Step 3: another day, another conversation, no introduction. */
  later: {
    marker: '第二天，另开一个对话',
    user: '下周拍什么？',
    coach: '你的定位和资料我都记着：下班后 15 分钟上桌的家常菜，每天下班后有一小时。下周就从你以前写过的"冰箱剩菜"接着拍。',
    sources: ['当前定位', '以前发的做饭记录.txt'],
  },
  sourcesLabel: '用到的资料',
} as const;

/** 文风参考: heading and line are region 5's (approved); step 1 is sample J's (approved); the rest is NEW. */
export const L_SHOWCASE_VOICE = {
  name: '文风参考',
  title: care('voice').worry,
  line: care('voice').does,
  beats: [
    { label: J_VOICE.steps[0].label, line: J_VOICE.steps[0].explain },
    { label: '整理出你的文风，你确认', line: '它读完你的文字，整理出语气、句子长短、开头方式和常用表达；你看过、改过、确认后才用。' },
    { label: '按你的文风写稿', line: '打开"使用我的文风"，新稿放在你的原文旁边比一比：像你本人，没有 AI 味。' },
  ] as readonly ShowcaseBeat[],
  /** The two old writings uploaded as "我本人写的" (sample J's file names). */
  files: ['以前发的做饭记录.txt', '小红书旧笔记.md'],
  profile: {
    title: '文风画像',
    status: '第 1 版 · 等你确认',
    /** 语气, 句子长短 and 开头方式 reuse sample J's approved profile rows. */
    rows: [
      ['语气', '像跟朋友聊天，常用"你"和"我"'],
      ['句子长短', '短句多，一句只说一件事'],
      ['开头方式', '先讲自己的经历，再讲做法'],
      ['常用表达', '"别扔""十五分钟""够了"'],
      ['不用的表达', '"家人们"'],
    ] as readonly (readonly [string, string])[],
    sampleLabel: '最像你的一段',
    sample: '下班到家七点多。冰箱里剩半把青菜、两个蛋，我十分钟炒好，配昨天的米饭，够了。',
    basis: '依据：以前发的做饭记录.txt、小红书旧笔记.md',
    edit: '修改',
    confirm: '确认使用',
  },
  write: {
    toggle: '使用我的文风',
    user: '用我的文风，写这条剩菜视频的开头。',
    coach: '按你的文风写好了，放在你以前写的一段旁边，你看像不像：',
    mine: '你以前写的',
    draft: '按你的文风写的新稿',
    /** Sample J's approved "按你的文风" line. */
    draftText: '我冰箱里总剩半盒米饭、一点青菜。别扔，十五分钟变一盘新菜。',
    generic: '一般 AI 会写成：',
    /** Sample J's approved "一般 AI 的写法" line. */
    genericText: '冰箱中的剩余食材可通过合理搭配，制作出营养均衡的新菜品。',
    /** Sample J's approved reply. */
    reply: '挺像我的。',
  },
} as const;
