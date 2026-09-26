/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import {
  DEFAULT_ELICITATION,
  elicitFieldSpecs,
  fieldElicitation,
  isAgentProposal,
} from "./opcMethodPolicy";

it("uses the field's own published declaration", () => {
  expect(fieldElicitation({ id: "anything", elicitation: "user_fact" })).toBe("user_fact");
  expect(fieldElicitation({ id: "anything", elicitation: "agent_proposal" })).toBe("agent_proposal");
  expect(isAgentProposal({ id: "anything", elicitation: "agent_proposal" })).toBe(true);
  expect(isAgentProposal({ id: "anything", elicitation: "user_fact" })).toBe(false);
});

it("defaults a revision without the property to a user-owned fact", () => {
  expect(DEFAULT_ELICITATION).toBe("user_fact");
  // Names that the removed field-name table used to classify as deliverables
  // must no longer become proposals on their own.
  for (const id of ["position", "names", "offer", "topics", "operations", "difference"]) {
    expect(fieldElicitation({ id })).toBe("user_fact");
    expect(isAgentProposal({ id })).toBe(false);
  }
  expect(fieldElicitation({ id: "niche" })).toBe("user_fact");
  expect(fieldElicitation({ id: "some_future_field" })).toBe("user_fact");
  expect(fieldElicitation(null)).toBe("user_fact");
  expect(fieldElicitation(undefined)).toBe("user_fact");
});

it("treats an unrecognized declaration value as the conservative default", () => {
  // The published schema rejects this value; a stale or hand-made object must
  // still not be able to claim an Agent proposal role.
  expect(fieldElicitation({ id: "position", elicitation: "AGENT_PROPOSAL" as never })).toBe("user_fact");
  expect(fieldElicitation({ id: "position", elicitation: "" as never })).toBe("user_fact");
});

it("never derives a role from the step or the field position", () => {
  const schema = [
    { id: "a", title: "第一", required: true },
    { id: "b", title: "第二", required: true, elicitation: "agent_proposal" as const },
    { id: "c", title: "第三", required: false, elicitation: "user_fact" as const },
  ];
  expect(elicitFieldSpecs(schema)).toEqual([
    { id: "a", title: "第一", required: true, elicit: "user_fact" },
    { id: "b", title: "第二", required: true, elicit: "agent_proposal" },
    { id: "c", title: "第三", required: false, elicit: "user_fact" },
  ]);
});

it("projects only the declared fields it receives, with their declared roles", () => {
  expect(elicitFieldSpecs([])).toEqual([]);
  expect(elicitFieldSpecs([{ id: "position", elicitation: "agent_proposal" }])).toEqual([
    { id: "position", title: "position", required: false, elicit: "agent_proposal" },
  ]);
  // A field's title never influences its role.
  expect(elicitFieldSpecs([{ id: "x", title: "五个账号名称建议及评价", required: true }])).toEqual([
    { id: "x", title: "五个账号名称建议及评价", required: true, elicit: "user_fact" },
  ]);
});
