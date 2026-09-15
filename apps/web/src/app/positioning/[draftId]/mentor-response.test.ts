/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { readMentorResponse } from "./mentor-response";

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
