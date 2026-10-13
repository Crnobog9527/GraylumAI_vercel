/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { OPENING, QUESTION_ONE } from '@/components/landing/demo/demo-script';
import { PUBLISH_PLATFORMS } from '@/lib/landing/landing-flow';

/**
 * Sample G's nine scene conversations, one per walk-through step (FLOW_STEPS ids, titles shown from there).
 * The same fictional beginner as the clickable demo (a dental assistant in Canada, labelled 示例), so the scenes
 * read as one person's journey. Lines say only what the product does: no follower, view, income or growth
 * numbers, and benchmark figures are shown as "computed by the program" instead of made-up values.
 */
export type SceneCard =
  | { type: 'options'; question: string; options: readonly string[]; recommended: number; reason: string }
  | { type: 'sheet'; title: string; rows: readonly (readonly [string, string])[]; action?: string }
  | { type: 'table'; title: string; columns: readonly string[]; rows: readonly (readonly string[])[]; caption: string }
  | { type: 'chips'; title: string; items: readonly string[] }
  | { type: 'outline'; title: string; items: readonly string[] };

export type SceneLine = { role: 'user' | 'coach'; text: string; card?: SceneCard };

export type Scene = { id: string; context: string; lines: readonly SceneLine[] };

const COMPUTED = '程序算出';

export const SCENES: readonly Scene[] = [
  {
    id: 'step-chat', context: '定位对话 · 你是谁',
    lines: [
      { role: 'coach', text: OPENING },
      { role: 'user', text: '我在加拿大做牙科助理，下班后和周末有点时间，想做个账号，但不知道能拍什么。' },
      {
        role: 'coach', text: '先不急着定拍什么。我们先看你手里有什么：经历、资源，还有你愿意长期聊的话题。',
        card: {
          type: 'options', question: QUESTION_ONE.question, options: QUESTION_ONE.options,
          recommended: QUESTION_ONE.recommended ?? 0, reason: QUESTION_ONE.recommendationReason ?? '',
        },
      },
      { role: 'user', text: QUESTION_ONE.options[QUESTION_ONE.recommended ?? 0] },
      {
        role: 'coach', text: '好，这条路是你自己走过的，别人很难替代。这一步的信息齐了，请核对一下：',
        card: {
          type: 'sheet', title: '本步小结', action: '确认这一步',
          rows: [
            ['可以讲的经验', '在加拿大从零入行做牙科助理'],
            ['每周能投入的时间', '下班后和周末'],
            ['想帮的人', '刚到加拿大、想转行的新移民'],
          ],
        },
      },
    ],
  },
  {
    id: 'step-truth', context: '定位对话 · 方向判断',
    lines: [
      { role: 'user', text: '我还是想主要讲日常怎么护理牙齿，这个话题看的人多。' },
      {
        role: 'coach',
        text: '说句实话：这类话题牙医和品牌都在讲，你作为助理不占优势，也比较难变现。看的人多，不等于有人愿意为你付费。',
      },
      {
        role: 'coach', text: '我的建议是把护理知识当作补充，主线放在你自己的入行经历上。',
        card: {
          type: 'options', question: '方向怎么定？',
          options: ['主线讲入行经历，护理知识做补充', '还是以护理知识为主', '先看看对标账号再决定'],
          recommended: 0, reason: '想入行的人遇到的是具体问题，也更愿意为具体的帮助付费；这是你的优势。',
        },
      },
      { role: 'user', text: '那就按你说的，主线讲入行经历。' },
    ],
  },
  {
    id: 'step-research', context: '定位对话 · 找对标',
    lines: [
      { role: 'user', text: '我关注了几个讲转行的博主，链接发你，帮我看看还有哪些可以参考。' },
      {
        role: 'coach', text: '我按你的方向查了一轮，候选分成三类。你从里面挑 3–5 个，我们只盯这几个。',
        card: {
          type: 'chips', title: '候选对标（三类）',
          items: ['同方向：新移民转行经验', '相近：医疗行业职场分享', '可借鉴形式：一条只讲一个步骤的教程号'],
        },
      },
      { role: 'user', text: '前两类里各挑两个。' },
      {
        role: 'coach', text: '数据已经填进表格。这些数字是实时查出来、由程序算出的，我改不了；查不到的格子会直接写"未取到"。',
        card: {
          type: 'table', title: '对标账号', columns: ['账号', '播放中位数', '互动率', '更新频率'],
          rows: [
            ['同方向 1', COMPUTED, COMPUTED, COMPUTED],
            ['同方向 2', COMPUTED, COMPUTED, COMPUTED],
            ['相近 1', COMPUTED, COMPUTED, COMPUTED],
            ['相近 2', '未取到', COMPUTED, COMPUTED],
          ],
          caption: '示例不展示具体数字；真实对话里这里是程序算出的结果。',
        },
      },
    ],
  },
  {
    id: 'step-report', context: '定位对话 · 出报告',
    lines: [
      { role: 'user', text: '前面几步我都确认了，可以出报告了吗？' },
      {
        role: 'coach', text: '可以。报告里每一条结论，都来自你确认过的信息和刚才的对标数据。下面是目录和开头：',
        card: {
          type: 'outline', title: '定位报告（示例）',
          items: [
            '一句话定位：帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理。',
            '账号三件套：名字「牙助阿杰的转行笔记」、简介、头像和封面',
            '对标拆解：每个对标账号做对了什么、你能学哪一点',
            '第一个 30 天计划：每周一个主题，从你自己怎么入行讲起',
            '变现路线：先用免费内容建立信任，再做一对一入行咨询',
          ],
        },
      },
    ],
  },
  {
    id: 'step-library', context: '新对话 · 没有重新介绍自己',
    lines: [
      { role: 'user', text: '这周发什么？' },
      {
        role: 'coach', text: '按你的定位，这周接着讲入行准备。我从你上传的课程笔记里挑了三个题目：',
        card: {
          type: 'outline', title: '这周的三个题目',
          items: ['入行前要准备哪些证书', '课程怎么选：我当时踩过的坑', '第一份工作的面试会问什么'],
        },
      },
      {
        role: 'coach', text: '这次回答用到了你资料库里的这些内容：',
        card: {
          type: 'chips', title: '资料库',
          items: ['定位档案：新移民转行做牙科助理', '上传的文件：课程笔记', '文风画像：口语化，先讲经历再讲方法'],
        },
      },
    ],
  },
  {
    id: 'step-voice', context: '写内容',
    lines: [
      { role: 'user', text: '用第二个题目写一条口播稿。' },
      {
        role: 'coach', text: '按你确认过的文风画像来写：先讲你自己的经历，再讲方法，句子短，像跟朋友聊天。',
        card: {
          type: 'outline', title: '口播稿（示例节选）',
          items: [
            '开头：我当年选课花了冤枉钱，今天把踩过的坑一次讲清楚。',
            '第一段：先看课程有没有带实习，这一条最容易被忽略。',
            '结尾：你现在卡在哪一步，留言告诉我，下一条就讲它。',
          ],
        },
      },
      { role: 'coach', text: '哪句不像你会说的话，直接告诉我，我按你的改法调整。' },
    ],
  },
  {
    id: 'step-publish', context: '发出去',
    lines: [
      { role: 'user', text: '稿子定了，帮我发出去。' },
      {
        role: 'coach', text: '选好要发的平台，确认后一次发出，不用再复制到各个平台。',
        card: { type: 'chips', title: '发布到', items: PUBLISH_PLATFORMS },
      },
      { role: 'user', text: '就发 TikTok、Instagram 和 YouTube。' },
    ],
  },
  {
    id: 'step-review', context: '每周复盘',
    lines: [
      {
        role: 'coach', text: '这是本周复盘。我看的是你这周真实发出去的内容和平台数据，不是猜的。',
        card: {
          type: 'sheet', title: '本周复盘（示例）',
          rows: [
            ['哪条有效', '讲证书清单的那条，收藏和提问都比其他几条多'],
            ['为什么', '内容具体，看完就能照着做，正是想入行的人要的'],
            ['下周怎么调', '多做"清单 + 你的亲身经历"这种形式，每周至少一条'],
          ],
        },
      },
      { role: 'user', text: '好，下周就这么排。' },
    ],
  },
  {
    id: 'step-fusion', context: '多模型评审团（Gold）',
    lines: [
      { role: 'user', text: '开始之前，帮我把这份 30 天计划再审一遍。' },
      {
        role: 'coach', text: '交给评审团：模型 A、B、C 先各自独立作答，互相看不到；再交叉挑错。',
        card: {
          type: 'sheet', title: '评审过程（示例）', action: '查看修订对比',
          rows: [
            ['模型 A', '第 3 周和第 1 周的内容有重复'],
            ['模型 B', '变现开始得太早，信任还没建立起来'],
            ['交叉挑错', '三方核对后保留两条意见，修订计划顺序'],
          ],
        },
      },
      { role: 'coach', text: '修订版已经出来了，你可以和原稿逐条对比，看改了哪里、为什么改。' },
    ],
  },
];

export function findScene(id: string) {
  return SCENES.find(scene => scene.id === id) ?? null;
}
