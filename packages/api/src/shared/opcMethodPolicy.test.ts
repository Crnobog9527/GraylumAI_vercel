/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import {
  elicitFieldSpecs,
  fieldElicitation,
  isAgentProposal,
} from "./opcMethodPolicy";

it("classifies the user's own facts as elicitation targets", () => {
  for (const id of ["niche", "audience", "short_goal", "constraints", "benchmarks"])
    expect(fieldElicitation({ id })).toBe("user_fact");
});

it("classifies named deliverables as Agent proposals", () => {
  for (const id of ["names", "position", "difference", "topics", "operations", "offer"])
    expect(isAgentProposal({ id })).toBe(true);
});

it("lets a published declaration win over the versioned table", () => {
  expect(fieldElicitation({ id: "niche", elicitation: "agent_proposal" })).toBe("agent_proposal");
  expect(fieldElicitation({ id: "position", elicitation: "user_fact" })).toBe("user_fact");
});

it("defaults an unknown field to a user-owned fact instead of guessing", () => {
  expect(fieldElicitation({ id: "some_future_field" })).toBe("user_fact");
  expect(fieldElicitation(null)).toBe("user_fact");
  expect(fieldElicitation(undefined)).toBe("user_fact");
});

it("classifies per field, not per step", () => {
  // Step 2 (对标账号分析) mixes both: the user supplies examples and accepts
  // the research limits, while the opportunity analysis is the Agent's proposal.
  expect(fieldElicitation({ id: "research_limits" })).toBe("user_fact");
  expect(fieldElicitation({ id: "opportunity" })).toBe("agent_proposal");
});

it("projects only the declared fields of the viewed question", () => {
  expect(elicitFieldSpecs([
    { id: "position", title: "一句话核心商业定位", required: true },
    { id: "constraints", title: "资源约束", required: false },
  ])).toEqual([
    { id: "position", title: "一句话核心商业定位", required: true, elicit: "agent_proposal" },
    { id: "constraints", title: "资源约束", required: false, elicit: "user_fact" },
  ]);
});
