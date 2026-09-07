/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
const uuid = z.string().uuid();
export const publicWorkflowSchema = z.object({
  id: z.string(),
  version: z.number(),
  kind: z.enum(["social", "document"]),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      dependsOn: z.array(z.string()),
      minLength: z.number(),
      maxLength: z.number(),
      requiresEvidence: z.boolean(),
    }),
  ),
  report: z.object({
    id: z.string(),
    version: z.number(),
    title: z.string(),
    sections: z.array(z.object({ title: z.string(), stepId: z.string() })),
  }),
});
export type PublicWorkflow = z.infer<typeof publicWorkflowSchema>;
export const snapshotSchema = z.object({
  projectId: uuid,
  roundId: uuid,
  skillId: uuid,
  state: z.enum(["draft", "published", "abandoned"]),
  currentVersion: z.number(),
  revisionId: uuid,
  packageHash: z.string(),
  workflowHash: z.string(),
  templateHash: z.string(),
  workflow: publicWorkflowSchema,
  steps: z.record(
    z.string(),
    z.object({
      body: z.string().nullable(),
      version: z.number(),
      reviewVersion: z.number(),
      evidenceIds: z.array(uuid),
      provenanceIds: z.array(uuid),
      confirmationId: uuid.nullable(),
      valid: z.boolean(),
      available: z.boolean().optional(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: uuid,
      kind: z.string(),
      supersedes: uuid.nullable(),
      hash: z.string(),
      createdAt: z.string(),
      available: z.boolean(),
      payload: z.json(),
    }),
  ),
  candidates: z.array(
    z.object({
      id: uuid,
      stepId: z.string(),
      body: z.string().nullable(),
      evidenceIds: z.array(uuid),
      directEvidenceIds: z.array(uuid).max(64).nullable(),
    }),
  ),
  confirmations: z.array(
    z.object({
      id: uuid,
      stepId: z.string(),
      version: z.number(),
      reviewVersion: z.number(),
      body: z.string().nullable(),
      evidenceIds: z.array(uuid),
    }),
  ),
});
export type ArtifactSnapshot = z.infer<typeof snapshotSchema>;
export const projectSchema = z.object({
  title: z.string(),
  projectId: uuid,
  moduleId: uuid,
  skillId: uuid,
  account: z.string().nullable(),
  currentVersion: z.number(),
  createdAt: z.string(),
});
export const roundSchema = z.object({
  roundId: uuid,
  state: z.enum(["draft", "published", "abandoned"]),
  revisionId: uuid,
  packageHash: z.string(),
  workflowHash: z.string(),
  templateHash: z.string(),
  version: z.number().nullable(),
  createdAt: z.string(),
});
export type ArtifactProject = z.infer<typeof projectSchema>;
export type ArtifactRound = z.infer<typeof roundSchema>;
export const reportSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  version: z.number().optional(),
  id: uuid.optional(),
  hash: z.string().optional(),
  report: z
    .object({
      title: z.string(),
      sections: z.array(
        z.object({
          title: z.string(),
          stepId: z.string(),
          body: z.string(),
          confirmationId: uuid,
          evidenceIds: z.array(uuid),
        }),
      ),
      sources: z.array(z.object({ id: uuid }).passthrough()),
      limitations: z.string(),
    })
    .passthrough()
    .optional(),
});
export type ArtifactReport = z.infer<typeof reportSchema>;
// Render untrusted text as literal Markdown, including raw HTML, images and links.
export function literalMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, "\\$1");
}
export function reportMarkdown(value: ArtifactReport): string {
  if (!value.available || !value.report)
    throw new Error("ARTIFACT_EVIDENCE_UNAVAILABLE");
  const r = value.report;
  return (
    [
      `# ${literalMarkdown(r.title)}`,
      `版本：${value.version}`,
      ...r.sections.map(
        (s) =>
          `## ${literalMarkdown(s.title)}\n\n${literalMarkdown(s.body)}\n\n来源：${s.evidenceIds.join(", ") || "未提供"}`,
      ),
      "## 来源记录",
      ...r.sources.map((s) => literalMarkdown(JSON.stringify(s))),
      "## 局限",
      literalMarkdown(
        typeof r.limitations === "string"
          ? r.limitations
          : JSON.stringify(r.limitations),
      ),
      `报告校验：${value.hash}`,
    ].join("\n\n") + "\n"
  );
}
