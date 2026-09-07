/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEmailVerified } from "../../lib/auth";
import { databaseArtifactStore, commandSchema } from "./store";
import { workflowSchema } from "./workflow";
import {
  publicWorkflowSchema,
  projectSchema,
  roundSchema,
  snapshotSchema,
  reportSchema,
  reportMarkdown,
} from "./public";
const uuid = z.string().uuid();
export const webCommandSchema = z.discriminatedUnion("action", [
  commandSchema.options[2],
  commandSchema.options[2].omit({ evidenceIds: true }).extend({
    action: z.literal("saveCandidate"),
    candidateId: uuid,
  }),
  commandSchema.options[4],
  commandSchema.options[5].extend({
    expectedSteps: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        z
          .object({
            version: z.number().int().nonnegative(),
            reviewVersion: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32),
  }),
  commandSchema.options[6],
  commandSchema.options[8],
  commandSchema.options[9],
]);
export const startSchema = z
  .object({
    projectId: uuid,
    roundId: uuid,
    requestId: uuid,
    registration: z.string().max(100).optional(),
    fromRoundId: uuid.optional(),
    upgrade: z.literal(true).optional(),
    account: z.string().max(160).nullable().optional(),
  })
  .strict();
const registrationSchema = z.object({
  id: z.string(),
  label: z.string(),
  moduleId: uuid,
  skillId: uuid,
  revisionId: uuid,
  packageHash: z.string(),
  workflow: workflowSchema,
  accounts: z.array(z.string()),
});
const resolvedSchema = z.object({
  moduleId: uuid,
  skillId: uuid,
  account: z.string().nullable(),
  revisionId: uuid,
  workflow: workflowSchema,
});
export function workbenchService(
  userClient: SupabaseClient,
  privateClient: SupabaseClient | null,
) {
  async function actor() {
    if (typeof window !== "undefined" || !privateClient)
      throw new Error("ARTIFACT_UNAVAILABLE");
    const auth = await userClient.auth.getUser();
    if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user))
      throw new Error("ARTIFACT_DENIED");
    return auth.data.user.id;
  }
  async function query(action: string, projectId?: string, roundId?: string) {
    const id = await actor();
    const { data, error } = await privateClient!
      .rpc("artifact_query", {
        p_actor_id: id,
        p_action: action,
        p_project_id: projectId ?? null,
        p_round_id: roundId ?? null,
      })
      .abortSignal(AbortSignal.timeout(10000));
    if (error)
      throw new Error(
        error.code === "42501" ? "ARTIFACT_DENIED" : "ARTIFACT_UNAVAILABLE",
      );
    return data;
  }
  const catalog = async () => {
    const registrations = registrationSchema
      .array()
      .parse(await query("catalog"));
    if (!registrations.length) return registrations;
    const visible = await userClient
      .from("modules")
      .select("id,active")
      .in("id", [...new Set(registrations.map((r) => r.moduleId))])
      .eq("active", true);
    if (visible.error) throw new Error("ARTIFACT_UNAVAILABLE");
    const ids = new Set((visible.data ?? []).map((r) => r.id));
    return registrations.filter((r) => ids.has(r.moduleId));
  };
  const resolve = async (projectId: string, roundId: string) =>
    resolvedSchema.parse(
      await query("resolve", uuid.parse(projectId), uuid.parse(roundId)),
    );
  async function store(projectId: string, roundId: string) {
    const s = await resolve(projectId, roundId);
    return databaseArtifactStore({
      userClient,
      privateClient,
      ...s,
      registrations: {
        fixed: { revisionId: s.revisionId, workflow: s.workflow },
      },
    });
  }
  return {
    async catalog() {
      return (await catalog()).map((r) => ({
        id: r.id,
        label: r.label,
        moduleId: r.moduleId,
        skillId: r.skillId,
        revisionId: r.revisionId,
        packageHash: r.packageHash,
        workflow: publicWorkflowSchema.parse(r.workflow),
        accounts: r.accounts,
      }));
    },
    async projects() {
      return projectSchema.array().parse(await query("projects"));
    },
    async rounds(projectId: string) {
      return roundSchema
        .array()
        .parse(await query("rounds", uuid.parse(projectId)));
    },
    async read(projectId: string, roundId: string) {
      return snapshotSchema.parse(
        await query("read", uuid.parse(projectId), uuid.parse(roundId)),
      );
    },
    async start(input: z.infer<typeof startSchema>) {
      const v = startSchema.parse(input);
      const prior = v.fromRoundId
        ? await resolve(v.projectId, v.fromRoundId)
        : null;
      if ((v.upgrade && !prior) || (!v.upgrade && prior && v.registration))
        throw new Error("ARTIFACT_INVALID_WORKFLOW");
      const entry =
        prior && !v.upgrade
          ? prior
          : (await catalog()).find((r) => r.id === v.registration);
      if (!entry) throw new Error("ARTIFACT_UNAVAILABLE");
      if (
        prior &&
        (entry.moduleId !== prior.moduleId || entry.skillId !== prior.skillId)
      )
        throw new Error("ARTIFACT_DENIED");
      const account = prior ? prior.account : (v.account ?? null);
      if (
        !prior &&
        entry.workflow.kind === "social" &&
        (!("accounts" in entry) || !entry.accounts.includes(account ?? ""))
      )
        throw new Error("ARTIFACT_DENIED");
      const s = databaseArtifactStore({
        userClient,
        privateClient,
        ...entry,
        registrations: {
          selected: { revisionId: entry.revisionId, workflow: entry.workflow },
        },
      });
      return z.object({ roundId: uuid }).parse(
        await s.start({
          projectId: v.projectId,
          roundId: v.roundId,
          requestId: v.requestId,
          registration: "selected",
          account,
          fromRoundId: v.fromRoundId,
        }),
      );
    },
    async execute(input: z.infer<typeof webCommandSchema>) {
      const v = webCommandSchema.parse(input);
      if (v.action === "publish" || v.action === "saveCandidate") {
        const fixed = await resolve(v.projectId, v.roundId),
          id = await actor();
        const visible = await userClient
          .from("modules")
          .select("id,active")
          .eq("id", fixed.moduleId)
          .eq("active", true)
          .single();
        if (visible.error || visible.data?.id !== fixed.moduleId)
          throw new Error("ARTIFACT_DENIED");
        const result = await privateClient!
          .rpc(
            v.action === "publish"
              ? "artifact_publish_current"
              : "artifact_save_candidate",
            {
              p_actor_id: id,
              p_module_id: fixed.moduleId,
              p_skill_id: fixed.skillId,
              p_project_id: v.projectId,
              p_round_id: v.roundId,
              p_request_id: v.requestId,
              ...(v.action === "publish"
                ? { p_expected_steps: v.expectedSteps }
                : {
                    p_step_id: v.stepId,
                    p_candidate_id: v.candidateId,
                    p_expected_version: v.expectedVersion,
                    p_body: v.body,
                  }),
            },
          )
          .abortSignal(AbortSignal.timeout(10000));
        if (result.error)
          throw new Error(
            result.error.code === "42501"
              ? "ARTIFACT_DENIED"
              : result.error.message === "save conflict"
                ? "ARTIFACT_VERSION_CONFLICT"
                : result.error.code === "P0001"
                  ? "ARTIFACT_REVIEW_REQUIRED"
                  : "ARTIFACT_UNAVAILABLE",
          );
      } else await (await store(v.projectId, v.roundId)).execute(v);
      return { accepted: true };
    },
    async report(projectId: string, roundId: string) {
      return reportSchema.parse(
        await (
          await store(projectId, roundId)
        ).execute({ action: "report", projectId, roundId }),
      );
    },
    async export(projectId: string, roundId: string) {
      const report = reportSchema.parse(
        await (
          await store(projectId, roundId)
        ).execute({ action: "report", projectId, roundId }),
      );
      return {
        filename: `report-v${report.version ?? 0}.md`,
        markdown: reportMarkdown(report),
      };
    },
  };
}
