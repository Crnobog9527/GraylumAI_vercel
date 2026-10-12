/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * The 16 FAQ answers, verbatim from the Owner's final offer (2026-10-13, section 5). The Owner edited
 * them by hand: do not reword, reorder or merge. Each paragraph is one line of the answer; an answer
 * whose capabilities are switched off is hidden as a whole (`needs`, see landing-flags.ts).
 */
export type LandingFaqItem = { id: string; question: string; answer: readonly string[]; needs: readonly LandingFeature[] };
export type LandingFaqGroup = { title: string; items: readonly LandingFaqItem[] };

export const LANDING_FAQ_TITLE = '常见问题';

export const LANDING_FAQ: readonly LandingFaqGroup[] = [
  {
    title: '关于教练',
    items: [
      {
        id: 'faq-1', needs: ['coach', 'research', 'library', 'voice'],
        question: 'Graylum AI 教练和 ChatGPT、Claude 这些有什么区别？',
        answer: [
          '你大概也试过：问它"我该做什么内容"，它给你一堆听起来都对、但哪条都用不上的建议。不是它不聪明，是它不了解你，也只能等你提问。通用AI什么都会一点，但它既没有真正的行业专家经验，也不懂真实业务。',
          'Graylum AI 教练反过来：它先按一套系统化的运营方法主动问你，问的是你的经历、资源和目标；然后从你要做的平台，去抓取对标账号的真实数据做赛道差异化分析；教练会一直记得你的定位、资料和文风，下次开个新窗口，不用再从'
            + '头介绍自己。你得到的不是"正确的废话"，而是针对你这个账号的判断。',
        ],
      },
      {
        id: 'faq-2', needs: ['coach'],
        question: '我没做过账号，也不会用 AI，能用吗？',
        answer: [
          '能。在设计 Graylum AI 教练的时候，我们考虑到了大量的用户都是非技术人员，也不是专业的自媒体从业者。因此，AI教练的所有功能都尽量做到了一键使用。你不需要会写提示词，你只要像和人聊天一样，说你的真实情况就行。它'
            + '一次只问你一个问题，每个问题都带例子，选项里还标了推荐。随时想停就停，下次回来接着聊，它会记得聊到哪了。',
        ],
      },
      {
        id: 'faq-3', needs: ['coach', 'content', 'publish'],
        question: '我拍不好、不想出镜，Graylum AI 教练能替我做吗？',
        answer: [
          '拍摄、出镜、录音这几件事得你本人来，这是你的账号，别人替不了。但在那之前的所有事，拍什么、脚本怎么写、标题和封面怎么起、发到哪、发了效果怎么样，都交给教练。你只需要把"你擅长的那部分"做出来。顺便说一句，不想出镜不等于做'
            + '不了，这正是定位阶段教练会和你一起解决的问题。',
        ],
      },
      {
        id: 'faq-4', needs: ['coach'],
        question: '我有问题的时候找谁？多久能有人理我？',
        answer: [
          'Graylum AI 教练本身 24 小时在，账号的事随时问，它看过你的定位和资料再回答。遇到产品问题找客服工单：免费用户 48 小时内回复，Pro 24 小时内，Gold 工作时间内 2 小时内。',
        ],
      },
    ],
  },
  {
    title: '关于我适不适合',
    items: [
      {
        id: 'faq-5', needs: ['coach', 'report', 'publish'],
        question: '多久能看到效果？',
        answer: [
          '分两种。有些东西当场就有：第一次聊完，你手里就有一份 Graylum AI 教练帮你梳理过的定位信息；开通订阅后，完整的策略分析报告和第一个 30 天计划就在你手里。另一些要等你做了才有：发了内容以后，数据会一周一周累积'
            + '，教练每周告诉你哪条有效、下周怎么调。',
        ],
      },
      {
        id: 'faq-6', needs: ['coach'],
        question: 'Graylum AI 教练能保证我涨粉、赚钱吗？',
        answer: [
          '不能。而且我们想直说一句：任何敢保证你涨粉、赚钱的课程、咨询、陪跑或者工具，一定是假的。',
          '我们能做的，是帮你找到适合你的方向、做出有差异的内容，并且给你一套运营方法。因为做自媒体不是一次性的事，它是一个长期的、精细的循环：测试、复盘、优化、调整，再来一遍。每个人的条件不一样，碰到的问题也很碎，这个行业非常依赖'
            + '经验和商业嗅觉。教练里装的，是创始人 9 年做自媒体和电商带货积累下来的经验和判断，以及操盘过大量账号和内容之后总结出的方法。它的任务，就是陪你把从 0 到 1、从 1 到 10 这一段走过去，把路上那些碎问题一个一个解'
            + '决掉。',
        ],
      },
      {
        id: 'faq-7', needs: ['coach', 'research', 'publish'],
        question: '我发了几十条都没人看，是我不适合做吗？要换方向吗？',
        answer: [
          '先别下结论。没人看通常不是人的问题，是方向、选题或者表达里有一个环节没对上，而你自己很难看出是哪个。让 Graylum AI 教练用真实数据帮你找出那个环节；如果真的是方向走不通，它会直说，并给你一个能走的。',
          '顺便说一句，很多人放弃不是因为累，是因为没反馈。有了每周复盘，你每周都知道上周哪里做对了、下一步做什么。',
        ],
      },
      {
        id: 'faq-8', needs: ['coach', 'research', 'library', 'publish'],
        question: '我已经做了一年多，大概知道该做什么，只是不确定做得对不对。Graylum AI 教练对我有用吗？',
        answer: [
          '比零基础的人更有用。做自媒体这行有个规律：有数据的账号，永远比空白账号好优化。任何运营专家离开了账号数据，都给不出有效的建议；你现在手里有数据，不管之前做得对还是错，反而是最适合用 Graylum AI 教练的时候。',
          '对已经有基础的你，它会这样帮你跨过瓶颈：',
          '1. 把你现有的定位资料上传到账号资料库，再连上你的账号。',
          '2. 教练自动取你的作品数据和趋势，不用你手动整理。',
          '3. 定位里不清楚、不够专业的地方，它会帮你重新梳理一遍，再在真实数据上告诉你差在哪、哪些做法在拖后腿。',
          '之后每周复盘，你不用再靠感觉判断。',
        ],
      },
      {
        id: 'faq-9', needs: ['coach', 'research', 'report', 'voice', 'content', 'publish'],
        question: '我主要做抖音、小红书，能用吗？',
        answer: [
          '能用，而且 Graylum AI 教练最值钱的部分你都能用：定位、对标研究（以页面上列出的已支持平台为准）、运营策略报告、写内容。只有"一键发布"和"自己作品的数据"这两项，目前只接了 TikTok、Instagram、'
            + 'YouTube、Facebook、X、Threads、LinkedIn、Pinterest、Bluesky 这几个海外平台。做国内平台的话，这两步要你自己手动发、自己看后台，其他都一样。',
        ],
      },
      {
        id: 'faq-10', needs: ['coach', 'content', 'publish'],
        question: '我开着店/上着班，每周要在这上面花多少时间？',
        answer: [
          '这个问题，你直接和 Graylum AI 教练说实话就行。哪怕每周只有 2 个小时、4 个小时，都没关系。它会按你真正能拿出来的时间、精力和资源，给你挑能做得下来的赛道和内容形式，而不是先给你一套理想方案、再让你自己去挤'
            + '时间。想选题、写脚本、看数据这些最耗时间的事，本来就是它来做。',
        ],
      },
    ],
  },
  {
    title: '关于付费和账号',
    items: [
      {
        id: 'faq-11', needs: ['coach', 'signupGrant'],
        question: '免费能得到什么？要绑卡吗？',
        answer: [
          '不用绑卡。注册送的积分，足够你和 Graylum AI 教练把情况聊透、把定位整理出来。这部分整理好的内容是你的，随时能看、能导出，我们不会收回。',
        ],
      },
      {
        id: 'faq-12', needs: ['coach', 'research', 'report', 'voice', 'content', 'publish'],
        question: '积分怎么用？$29 一个月够不够？',
        answer: [
          '按实际用量扣：对话、生成报告、联网搜索、查数据，用多少扣多少，没用就不扣。Pro 每月 3,480 积分，够你生成运营策略报告、按自己的文风写内容、一键发到各个平台、看自己近 30 天的数据，还能建 3 个定位档案。积分'
            + '永不过期，这个月没用完下个月还在；真不够，会员可以另外买积分包，Pro 会员 9.5 折，Gold 会员 9 折。',
        ],
      },
      {
        id: 'faq-13', needs: ['report', 'content', 'publish', 'fusion'],
        question: '我该选 Pro 还是 Gold？',
        answer: [
          '刚起步、先专心做好一个账号，Pro 就够了。已经在做多个平台的账号，或者想要每周有 Graylum AI 教练替你盯对标、做复盘，想让报告和选题稿件经过多个顶级模型评审团把关，建议选择 Gold 。使用途中随时能从 Pr'
            + 'o 升到 Gold，权益马上生效。',
        ],
      },
      {
        id: 'faq-14', needs: ['coach', 'report'],
        question: '能退款吗？能随时取消吗？到期后我的东西还在吗？',
        answer: [
          '退款：第一次买会员、积分包或者升级，7 天之内，而且从这次付款起账户没有用过积分，通过产品里的客服工单申请，人工审核后原路退回，扣 6% 手续费。',
          '取消：随时可以取消订阅和自动续费，用到当期结束。',
          '到期以后，你已经生成的报告和定位档案都还在，能看、能导出，只是无法再新建。',
        ],
      },
      {
        id: 'faq-15', needs: ['founder'],
        question: '创始会员和普通 Gold 年付差在哪？',
        answer: [
          '功能上没有差别，创始会员就是 Gold。差别在两件事。',
          '一是价格：第一年 $496，而不是 $621；以后只要续费不中断，每年都按当时 Gold 月付价 × 12 的 6 折算，不管以后套餐怎么调，这个折扣跟着你，调价会提前通知。',
          '二是离创始人更近：在创始会员社群里可以直接和创始人沟通；每半个月一次直播，拆解会员的真实账号；你的定位报告创始人会亲自看一眼，给你一句他的判断。',
        ],
      },
      {
        id: 'faq-16', needs: ['founder'],
        question: '为什么创始会员只有 50 个名额？',
        answer: [
          '因为上面那些事，创始人是亲自做的。社群里亲自回复、每半个月直播拆案例、每一位会员的定位报告都看一遍，一个人认真做，50 位是上限。再多，就会变成大家最反感的那种"进了群没人理"。所以名额招满就关闭，不加开、不放回，也不会'
            + '过几天又"限时重开"。页面上显示的剩余名额是实时的。',
        ],
      },
    ],
  },
];

/** Plain text of an answer, the same string the FAQPage JSON-LD carries. */
export function faqAnswerText(item: LandingFaqItem) {
  return item.answer.join('\n');
}
