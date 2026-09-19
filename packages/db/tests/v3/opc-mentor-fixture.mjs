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
      message: proposalField
        ? `【导师主动引导，仅验证流程】${where}：我先把“${title}”的草案放上来。${proposal}`
        : `【导师主动引导，仅验证流程】${where}：我先替你把“${title}”这个问题开个头。${easier}`,
      inputKind: "answer",
      informationPatch: proposalField ? patch(proposal, "provisional", "decision", "agent_proposal") : {},
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
    message: `【分步模拟，仅验证流程】${where}：现在只聊“${title}”。这次回答会作为本题的待核对信息，不会自动确认。还有什么要补充或修改的吗？准备好后，点击右侧本题的确认按钮继续。`,
    inputKind: "answer",
    informationPatch: fieldId && text ? patch(text, "provisional", "hypothesis", "user_statement") : {},
  };
}
