/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Deterministic local provider fixture, not a model or production dialogue
 * engine. It stands in for the model's *contextual* classification so the host
 * rules can be exercised end to end: for a non-substantive turn it deliberately
 * returns the naive "copy the utterance into the field" patch, and the host is
 * what must refuse it.
 */
export function mentorQuestionFixture(instructions, userRequest, stepIndex) {
  const marker = [...instructions.matchAll(/^Current information question: (.+)$/gm)].at(-1);
  const question = marker ? JSON.parse(marker[1]) : null;
  // The host owns the question's display identity. Use its label verbatim when
  // it is present; otherwise stay neutral instead of inventing a number from the
  // step index, the field title or the reply text.
  const label = typeof question?.label === "string" && /^\d+\.\d+$/.test(question.label) ? question.label : null;
  const where = label ? `第 ${label} 题` : "当前这一题";
  const roles = (() => {
    const found = /Field roles for the current question: (\[.*?\])(?:\. |\.$|$)/s.exec(instructions);
    try { return found ? JSON.parse(found[1]) : []; } catch { return []; }
  })();
  const role = roles.find(entry => entry.id === question?.id) ?? null;
  const proposalField = role?.elicit === "agent_proposal";
  const legacy = /Allowed field IDs(?: for the current step)?: (\[[^\]]*\])/.exec(instructions);
  const fieldId = question?.id ?? (legacy ? JSON.parse(legacy[1])[0] : undefined);
  const title = question?.title ?? "当前问题";
  // The approved six-stage browser scenario uses the same concrete questions
  // and example proposals as the merged reference. This mapping lives only at
  // the isolated provider boundary; the application still reads its Skill.
  const approved = {
    '产品与服务': ['先从你实际在做的事开始。你目前提供什么产品或服务？不必先写一份完整定位。', '摄影入门课程，用真实场景带新手练习取景。'],
    '准备经营的平台': ['你准备在哪个平台开始？可以只做一个，也可以明确选择多个；还没决定时，我会先帮你判断，不替你创建平台。', '先只做公众号。'],
    '每周可用时间': ['课程方向已经记住。你每周能稳定留多少时间制作内容？', '每周 3 小时。'],
    '参考研究结论': ['示例研究材料显示，一类账号强调参数讲解，另一类用前后对照解释判断。我建议优先借鉴“同一场景前后对照”的表达，而不追求高频器材评测。这个参考方向适合你吗？这是隔离示例，没有联网研究账号。', '借鉴同场景前后对照的讲解方式，不以器材评测为主。'],
    '优先服务的用户': ['结合已经确认的课程，我建议先帮助“会操作相机，但不知道如何整理画面”的新手，比覆盖所有摄影爱好者更具体。这与你实际服务的人相符吗？', '会操作相机，但不知道如何整理画面的摄影新手。'],
    '价值与依据': ['我建议把内容价值表达为“让新手看懂每一次取景调整的原因”。这个主张需要你的实际教学或拍摄经历支撑。你有一个可以使用的案例吗？', '曾带学员在同一街景中移动机位，用前后两张照片解释背景干扰。'],
    '内容表达与平台安排': ['根据已确认方向，我建议共用一组真实案例：公众号解释判断，小红书做练习清单。不是为两个平台各想一套独立内容。这个分工是否合适？', '公众号解释判断；小红书提供练习清单。'],
    '可持续的制作安排': ['每周总共只有 3 小时，我建议先完成一个核心案例，再选择最值得做的平台版本；本周不强求两个平台同时更新。你是否接受这个节奏？', '每周先做好一个核心案例，再按可用时间选择平台版本。'],
    '内容如何支持业务': ['内容应先让用户完成一次有效练习，再自然了解课程。我建议以课程服务为承接，不编造增长或收入承诺。这个方向是否符合你的业务？', '先帮助用户完成一次构图练习，再说明摄影入门课程能提供的系统训练。'],
  }[title];
  const text = typeof userRequest === "string" ? userRequest.trim() : "";
  const opening = text === "HOST_OPEN_CURRENT_QUESTION";
  const uncertain = /^(?:我(?:也|还|暂时)?|嗯|呃)?(?:不知道|不确定|不清楚|没想好|没有想好|还没想好|暂时不知道|not sure|i don't know|idk)(?:呢|啊|呀|吧|哦|了)?[。.!！?？…]*$/iu.test(text);
  const acknowledgement = /^(?:好的|好|好的呀|可以|行|嗯嗯|收到|没问题|就这么办|ok|okay|yes)[。.!！~～\s]*$/iu.test(text);
  const helpRequest = /^(?:你帮我|帮我|请帮我|你能不能帮我)/u.test(text);
  const proposal = proposalField
    ? `建议草稿：围绕“${title}”给出一个可直接使用的具体方案，依据已确认的信息，不声称做过真实研究。`
    : "";
  if (text === "模拟：修改第一步目标") return {targetStepId:"step-0",message:"【分步模拟，仅验证流程】可以回到已完成的问题核对这项修改，其余信息保留。",inputKind:"revision_request",informationPatch:{goal:{value:"改为帮助独立开发者",status:"provisional",nature:"decision",basis:"agent_proposal"}}};
  const easier = /赛道|领域/.test(title) ? "你平时最愿意研究或分享的一个话题是什么？"
    : /商业|卖点|内容/.test(title) ? "先不考虑怎么赚钱：你最熟悉、能反复分享的一项经验是什么？"
    : /受众|人群|目标/.test(title) ? "想一位你曾经帮助过的人：他当时遇到了什么困难？"
    : "先从一个具体经历说起：你最近做过哪件与这个问题有关的事？";
  const patch = (value, status, nature, basis) => fieldId ? {[fieldId]:{value:value.slice(0,400),status,nature,basis}} : {};
  if (opening) {
    return {
      // A distinct prefix keeps the Agent's own opening separable from a reply
      // to something the user said.
      message: approved ? approved[0] : proposalField
        ? `【导师主动引导，仅验证流程】${where}：我先把“${title}”的草案放上来。${proposal}`
        : `【导师主动引导，仅验证流程】${where}：我先替你把“${title}”这个问题开个头。${easier}`,
      inputKind: "answer",
      informationPatch: proposalField ? patch(approved?.[1]??proposal, "provisional", "decision", "agent_proposal") : {},
    };
  }
  if (uncertain) {
    return {
      message: `【分步模拟，仅验证流程】还没想清楚没关系，我们先把这一个问题聊清楚。${easier}`,
      inputKind: "uncertainty",
      // A naive provider copies the utterance. The host must refuse it.
      informationPatch: fieldId && text ? patch(text, "provisional", "hypothesis", "user_statement") : {},
    };
  }
  if (acknowledgement || helpRequest) {
    return {
      message: acknowledgement
        ? `【分步模拟，仅验证流程】收到。${proposalField ? proposal : "当前问题还没有可采用的建议，我先给一个更具体的例子，你再决定。"}`
        : `【分步模拟，仅验证流程】我来替你先写一版草案，你核对即可。${proposal || easier}`,
      inputKind: acknowledgement ? "acknowledgement" : "request",
      informationPatch: proposalField
        ? patch(proposal || `围绕“${title}”的草案建议`, "provisional", "decision", "agent_proposal")
        : fieldId && text ? patch(text, "provisional", "hypothesis", "user_statement") : {},
    };
  }
  return {
    message: approved ? `收到。我们现在只核对“${title}”。这次回答已作为待核对信息保留；还有什么要补充或修改的吗？准备好后再明确确认。` : `【分步模拟，仅验证流程】${where}：现在只聊“${title}”。这次回答会作为本题的待核对信息，不会自动确认。还有什么要补充或修改的吗？准备好后，点击右侧本题的确认按钮继续。`,
    inputKind: "answer",
    informationPatch: fieldId && text ? patch(text, "provisional", "hypothesis", "user_statement") : {},
  };
}
