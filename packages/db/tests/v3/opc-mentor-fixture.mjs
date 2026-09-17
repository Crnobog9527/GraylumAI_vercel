/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Deterministic local provider fixture, not a model or production dialogue engine. */
export function mentorQuestionFixture(instructions, userRequest, stepIndex) {
  const marker = [...instructions.matchAll(/^Current information question: (.+)$/gm)].at(-1);
  const question = marker ? JSON.parse(marker[1]) : null;
  const legacy = /Allowed field IDs(?: for the current step)?: (\[[^\]]*\])/.exec(instructions);
  const fieldId = question?.id ?? (legacy ? JSON.parse(legacy[1])[0] : undefined);
  const title = question?.title ?? "当前问题";
  const text = typeof userRequest === "string" ? userRequest.trim() : "";
  const uncertain = /^(?:我(?:也|还|暂时)?|嗯|呃)?(?:不知道|不确定|不清楚|没想好|没有想好|还没想好|暂时不知道|not sure|i don't know|idk)(?:呢|啊|呀|吧|哦|了)?[。.!！?？…]*$/iu.test(text);
  if (text === "模拟：修改第一步目标") return {targetStepId:"step-0",message:"【分步模拟，仅验证流程】可以回到已完成的问题核对这项修改，其余信息保留。",informationPatch:{goal:{value:"改为帮助独立开发者",status:"provisional",nature:"decision"}}};
  const easier = /赛道|领域/.test(title) ? "你平时最愿意研究或分享的一个话题是什么？"
    : /商业|卖点|内容/.test(title) ? "先不考虑怎么赚钱：你最熟悉、能反复分享的一项经验是什么？"
    : /受众|人群|目标/.test(title) ? "想一位你曾经帮助过的人：他当时遇到了什么困难？"
    : "先从一个具体经历说起：你最近做过哪件与这个问题有关的事？";
  return {
    message: `【分步模拟，仅验证流程】第 ${stepIndex + 1} 步：现在只聊“${title}”。` + (uncertain
      ? `还没想清楚没关系，我们先把这一个问题聊清楚。${easier}`
      : "这次回答会作为本题的待核对信息，不会自动确认。还有什么要补充或修改的吗？准备好后，点击右侧本题的确认按钮继续。"),
    informationPatch: fieldId && text && !uncertain ? {[fieldId]:{value:text.slice(0,400),status:"provisional",nature:"hypothesis"}} : {},
  };
}
