/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { webCommandSchema, startSchema } from "../artifacts/workbench";
import { reportMarkdown, publicWorkflowSchema } from "../artifacts/public";
import { makeWorkflow } from "./fixtures/artifacts";
describe("workbench browser boundary", () => {
  const scope = {
    projectId: randomUUID(),
    roundId: randomUUID(),
    requestId: randomUUID(),
  };
  it("allows explicit user commands and rejects internal execution or impersonation", () => {
    const save = {
      ...scope,
      action: "save",
      stepId: "step-0",
      expectedVersion: 0,
      body: "user text",
      evidenceIds: [],
    };
    expect(webCommandSchema.safeParse(save).success).toBe(true);
    for (const action of [
      "candidate",
      "researchEvidence",
      "read",
      "report",
      "execute",
      "start",
    ])
      expect(webCommandSchema.safeParse({ ...save, action }).success).toBe(
        false,
      );
    for (const field of ["actorId", "workflow", "moduleId", "revisionId"])
      expect(
        webCommandSchema.safeParse({ ...save, [field]: "injected" }).success,
      ).toBe(false);
    expect(
      startSchema.safeParse({
        ...scope,
        registration: "registered",
        workflow: makeWorkflow(3),
      }).success,
    ).toBe(false);
  });
  it("accepts only stored research identity for adoption, never a supplied result or price", () => {
    const value = { ...scope, action: "researchEvidence", planId: randomUUID(), operationId: randomUUID() };
    expect(webCommandSchema.safeParse(value).success).toBe(true);
    for (const field of ["actorId", "result", "body", "price", "chargedCredits"])
      expect(webCommandSchema.safeParse({ ...value, [field]: "injected" }).success).toBe(false);
  });
  it("allows adoption of an existing candidate without browser-controlled provenance", () => {
    const value = {
      ...scope,
      action: "saveCandidate",
      candidateId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 0,
      body: "edited candidate",
    };
    expect(webCommandSchema.safeParse(value).success).toBe(true);
    for (const field of [
      "evidenceIds",
      "actorId",
      "workflow",
      "moduleId",
      "revisionId",
    ])
      expect(
        webCommandSchema.safeParse({ ...value, [field]: [] }).success,
      ).toBe(false);
  });
  it("projects display constraints without exposing resource plans", () => {
    const result = publicWorkflowSchema.parse(makeWorkflow(6, true));
    expect(result.steps).toHaveLength(6);
    expect(result.steps[0]).toMatchObject({
      minLength: 1,
      maxLength: 20000,
      requiresEvidence: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /resources|references|Capabilities/,
    );
  });
  it("exports literal confirmed text and never exports unavailable cached content", () => {
    const report = {
      available: true,
      version: 1,
      hash: "fixed",
      report: {
        title: "<img src=x>",
        sections: [
          {
            title: "[unsafe](javascript:x)",
            stepId: "a",
            body: "<script>\n![img](data:text/html,x)\n```html",
            confirmationId: randomUUID(),
            evidenceIds: [],
          },
        ],
        sources: [],
        limitations: "No practice data",
      },
    };
    const text = reportMarkdown(report);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("![img]");
    expect(text).not.toContain("[unsafe]");
    expect(text).toContain("&lt;script&gt;");
    expect(() => reportMarkdown({ ...report, available: false })).toThrow(
      "ARTIFACT_EVIDENCE_UNAVAILABLE",
    );
  });
});
