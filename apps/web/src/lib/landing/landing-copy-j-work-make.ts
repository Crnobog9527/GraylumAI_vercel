/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { WorkScene } from './landing-copy-j-work';

/**
 * "定位之后，AI 教练接着陪你做内容": library, voice and publishing, step by step in the real product's screens
 * (Owner 2026-10-15). The page's example person. NEW WORDING for the Owner to approve.
 */
export const J_WORK_MAKE: readonly WorkScene[] = [
  {
    id: 'library', group: 1, title: '资料库，AI 教练记得你', needs: ['library'],
    result: '换一个对话窗口也不用重新介绍自己，做到哪里都接得上。',
    steps: [
      {
        label: '资料库里存着什么',
        explain: '你采用的选题、写好的稿件和当前定位，都按平台和账号存在资料库里，状态一眼能看清。',
        blocks: [{ kind: 'library', fresh: false }],
      },
      {
        label: '新采用的选题进来',
        explain: '在对话里点了"采用"的选题，会自动出现在资料库，标着"待创作"，不用你手动整理。',
        blocks: [{ kind: 'library', fresh: true }],
      },
      {
        label: '新对话直接接上',
        explain: '开一个新对话，AI 教练直接读资料库：你的定位、文风和做到哪一步都记着，接着往下做。',
        blocks: [
          { kind: 'user', text: '新对话：接着写周二那条。' },
          { kind: 'coach', text: '好，周二是"冰箱剩菜三种做法"。按你的定位，开头先拍剩菜，再给成品；稿子按你的文风写，我先出第一版给你看。' },
          { kind: 'rows', title: '这次用到的资料', rows: [['定位档案', '下班后 15 分钟家常菜'], ['文风画像', '短句，先讲自己的经历'], ['上周复盘', '剩菜类收藏最多']] },
        ],
      },
    ],
  },
  {
    id: 'voice', group: 1, title: '按你的文风写', needs: ['voice'],
    result: '写出来的稿子像你自己会说的话，不是千篇一律的 AI 腔。',
    steps: [
      {
        label: '上传你以前写的东西',
        explain: '在资料库的"上传文件"里，把你以前写的文字传上来，用途选"我本人写的"。',
        blocks: [{ kind: 'upload', done: false }],
      },
      {
        label: '上传完成',
        explain: '文件传完会标"已上传"，之后每次写稿都会参考这些文字。',
        blocks: [{ kind: 'upload', done: true }],
      },
      {
        label: '总结出你的文风',
        explain: 'AI 教练读完你的文字，总结出你说话的习惯，并告诉你依据是什么。',
        blocks: [
          { kind: 'coach', text: '读完了。这是你的文风画像：' },
          { kind: 'rows', title: '文风画像', rows: [['句子', '短句多，一句只说一件事'], ['口吻', '像跟朋友聊天，常用"你"和"我"'], ['习惯', '先讲自己的经历，再讲做法']] },
        ],
      },
      {
        label: '同一句话，写出来不一样',
        explain: '同样一段内容，一般 AI 的写法和按你文风的写法放在一起比，差别一眼就能看出来。',
        blocks: [
          {
            kind: 'compare',
            left: { label: '一般 AI 的写法', lines: ['冰箱中的剩余食材可通过合理搭配，制作出营养均衡的新菜品。'] },
            right: { label: '按你的文风', lines: ['我冰箱里总剩半盒米饭、一点青菜。别扔，十五分钟变一盘新菜。'] },
          },
        ],
      },
    ],
  },
  {
    id: 'publish', group: 1, title: '一次发到多个平台', needs: ['publish'],
    result: '不用把同一条内容复制到每个平台各发一遍，发完的记录也自动留在资料库。',
    steps: [
      {
        label: '按平台改好标题和标签',
        explain: '同一条内容，按每个平台的习惯改好标题和标签：短视频平台标题短，图文平台写清做法。',
        blocks: [
          { kind: 'coach', text: '这条要发三个平台，我按各自的习惯改好了：' },
          {
            kind: 'table', columns: ['平台', '标题', '标签'], rows: [
              ['TikTok', '剩菜别扔，十五分钟变新菜', '#快手菜 #一人食'],
              ['Instagram', '冰箱剩菜三种做法，步骤在图里', '#下班做饭 #一人食'],
              ['YouTube', '一个人吃饭：剩菜的三种做法', '#快手菜'],
            ],
          },
        ],
      },
      {
        label: '选平台，确认发出',
        explain: '勾上要发的平台，确认一次就一起发出，不用一个个平台去登录。',
        blocks: [{ kind: 'publish', sent: false }],
      },
      {
        label: '发出，并记进资料库',
        explain: '发出后，每个平台都显示已发布，资料库里这条也记为已发布；一周后复盘就从这些数据开始。',
        blocks: [{ kind: 'publish', sent: true }, { kind: 'coach', text: '三个平台都发出去了，资料库已更新。一周后我来给你做复盘。' }],
      },
    ],
  },
];
