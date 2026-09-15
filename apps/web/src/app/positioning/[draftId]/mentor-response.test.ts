/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { readMentorResponse, readWorkflowMentorResponse } from "./mentor-response";

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
