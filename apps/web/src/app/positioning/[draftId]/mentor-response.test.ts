/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  applyMentorTurnRules,
  readMentorResponse,
  readMentorTurn,
  readWorkflowMentorResponse,
  readWorkflowMentorTurn,
} from "./mentor-response";

describe("readMentorResponse", () => {
  it("keeps the public reply and narrows form suggestions", () => {
    const response = readMentorResponse(
      JSON.stringify({
        message: "我们先确认你想服务的人。",
        informationPatch: {
          audience: {
            value: "刚开始做短视频的独立开发者",
            status: "confirmed",
            nature: "hypothesis",
          },
          private_receipt: {
            value: "must not escape",
            status: "confirmed",
            nature: "fact",
          },
        },
      }),
      new Set(["audience"]),
    );
    expect(response.message).toBe("我们先确认你想服务的人。");
    expect(response.informationPatch).toEqual({
      audience: {
        value: "刚开始做短视频的独立开发者",
        status: "provisional",
        nature: "hypothesis",
      },
    });
  });

  it("keeps legacy plain-text replies readable", () => {
    expect(readMentorResponse("继续说说你的具体经历。", new Set())).toEqual({
      message: "继续说说你的具体经历。",
      informationPatch: {},
    });
  });
});

it("uses only the requested existing step's fields for a proposed revision", () => {
  const fields = {first:{schema:[{id:"goal"}]}, second:{schema:[{id:"account"}]}};
  const raw=JSON.stringify({message:"调整目标",targetStepId:"first",informationPatch:{goal:{value:"new goal",nature:"decision"},account:{value:"wrong field",nature:"fact"}}});
  expect(readWorkflowMentorResponse(raw,"second",fields)).toEqual({message:"调整目标",targetStepId:"first",informationPatch:{goal:{value:"new goal",status:"provisional",nature:"decision"}}});
  expect(readWorkflowMentorResponse(raw.replace('"first"','"__proto__"'),"second",fields).targetStepId).toBe("second");
});

it("does not redirect an explicitly invalid target into a same-named current field", () => {
  for (const targetStepId of ["missing", "__proto__", null, 3]) {
    const result=readWorkflowMentorResponse(JSON.stringify({message:"suggestion",targetStepId,informationPatch:{goal:{value:"must not be applied",nature:"decision"}}}),"first",{first:{schema:[{id:"goal"}]}});
    expect(result.message).toBe("suggestion");
    expect(result.informationPatch).toEqual({});
  }
});

describe("host rules for a non-substantive user turn", () => {
  const field = new Set(["position"]);
  const reply = (inputKind: string, value: string, basis: string) =>
    JSON.stringify({
      message: "reply",
      inputKind,
      informationPatch: { position: { value, nature: "decision", basis } },
    });

  it("never turns an uncertainty into an answer", () => {
    const turn = readMentorTurn(reply("uncertainty", "不知道", "user_statement"), field);
    expect(turn.inputKind).toBe("uncertainty");
    expect(applyMentorTurnRules(turn, "不知道")).toEqual({});
  });

  it("keeps an Agent proposal but drops the acknowledgement itself", () => {
    const copied = readMentorTurn(reply("acknowledgement", "好的", "user_statement"), field);
    expect(applyMentorTurnRules(copied, "好的")).toEqual({});
    const proposed = readMentorTurn(reply("acknowledgement", "围绕摄影的定位草案", "agent_proposal"), field);
    expect(Object.keys(applyMentorTurnRules(proposed, "好的"))).toEqual(["position"]);
  });

  it("drops a help request that merely echoes the user", () => {
    const turn = readMentorTurn(reply("request", "你帮我取名", "user_statement"), field);
    expect(applyMentorTurnRules(turn, "你帮我取名")).toEqual({});
  });

  it("drops a mislabelled proposal that only repeats a non-answer", () => {
    const turn = readMentorTurn(reply("acknowledgement", "好的", "agent_proposal"), field);
    expect(applyMentorTurnRules(turn, "好的")).toEqual({});
  });

  it("keeps a substantive answer and rejects unknown fields", () => {
    const turn = readMentorTurn(reply("answer", "面向刚开始做短视频的独立开发者", "user_statement"), field);
    expect(Object.keys(applyMentorTurnRules(turn, "我是做短视频工具的"))).toEqual(["position"]);
    const stray = readMentorTurn(
      JSON.stringify({ message: "reply", inputKind: "answer", informationPatch: { secret: { value: "x", nature: "fact" } } }),
      field,
    );
    expect(stray.informationPatch).toEqual({});
  });

  it("keeps legacy plain-text replies permissive", () => {
    const legacy = readMentorTurn("继续说说你的具体经历。", field);
    expect(legacy.inputKind).toBe("answer");
    expect(applyMentorTurnRules(legacy, "继续")).toEqual({});
  });
});

it("exposes the workflow-aware turn classification the page renders", () => {
  const fields = { first: { schema: [{ id: "goal" }] } };
  const raw = JSON.stringify({
    message: "open",
    inputKind: "answer",
    informationPatch: { goal: { value: "定位草案", nature: "decision", basis: "agent_proposal" } },
  });
  const turn = readWorkflowMentorTurn(raw, "first", fields);
  expect(turn.targetStepId).toBe("first");
  expect(turn.informationPatch.goal.basis).toBe("agent_proposal");
});
