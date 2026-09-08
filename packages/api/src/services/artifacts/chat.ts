/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEmailVerified } from "../../lib/auth";
import { workbenchService } from "./workbench";
import { checkInputSecurity } from "../../middleware/securityChecks";
const uuid = z.string().uuid();
export const chatScope = z.object({ conversationId: uuid }).strict();
export const chatEntry = z
  .object({
    moduleId: uuid.optional(),
    registration: z.string().max(100).optional(),
    projectId: uuid.optional(),
    roundId: uuid.optional(),
    account: z.string().max(160).optional(),
    requestId: uuid,
  })
  .strict();
export const chatTurnInput = chatScope
  .extend({
    requestId: uuid,
    stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    body: z.string().trim().min(1).max(2000),
  })
  .strict();
export const chatBinding = z.object({
  conversationId: uuid,
  projectId: uuid,
  roundId: uuid,
  moduleId: uuid,
  skillId: uuid,
  stepId: z.string(),
});
export const chatTurn = z.object({
  requestId: uuid,
  stepId: z.string(),
  body: z.string().nullable(),
  answer: z.string().nullable(),
  available: z.boolean(),
  candidateId: uuid.nullable(),
  generationState: z.string(),
  generationMode: z.enum(["legacy", "dual"]).default("legacy"),
  summaryRequestId: uuid.nullable().optional(),
  summaryState: z.string().optional(),
  summaryCandidateId: uuid.nullable().optional(),
  summaryDismissed: z.boolean().optional(),
  summaryBasis: z.record(z.string(),z.object({version:z.number(),reviewVersion:z.number()})).nullable().optional(),
  abandoned: z.boolean(),
  createdAt: z.string(),
});
export function skillChatService(
  userClient: SupabaseClient,
  privateClient: SupabaseClient | null,
) {
  async function call(
    action: string,
    conversationId?: string,
    payload: Record<string, unknown> = {},
  ) {
    if (typeof window !== "undefined" || !privateClient)
      throw new Error("ARTIFACT_UNAVAILABLE");
    const auth = await userClient.auth.getUser();
    if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user))
      throw new Error("ARTIFACT_DENIED");
    const result = await privateClient
      .rpc("artifact_chat", {
        p_actor_id: auth.data.user.id,
        p_action: action,
        p_conversation_id: conversationId ?? null,
        p_payload: payload,
      })
      .abortSignal(AbortSignal.timeout(10000));
    if (result.error)
      throw new Error(
        result.error.code === "42501"
          ? "ARTIFACT_DENIED"
          : "ARTIFACT_CONFLICT_OR_DENIED",
      );
    return result.data;
  }
  return {
    async stats() {
      return z
        .array(
          z.object({
            conversationId: uuid,
            messageCount: z.number(),
            creditsUsed: z.number(),
          }),
        )
        .parse(await call("stats"));
    },
    async mode(moduleId: string) {
      const visible = await userClient
        .from("modules")
        .select("id")
        .eq("id", uuid.parse(moduleId))
        .eq("active", true)
        .single();
      if (visible.error || !visible.data) throw new Error("ARTIFACT_DENIED");
      return z
        .object({ guided: z.boolean() })
        .parse(await call("mode", undefined, { moduleId }));
    },
    async enter(input: z.infer<typeof chatEntry>) {
      const v = chatEntry.parse(input),
        workbench = workbenchService(userClient, privateClient);
      if (v.projectId && v.roundId) {
        await workbench.read(v.projectId, v.roundId);
        return chatBinding.parse(await call("attach", undefined, v));
      }
      if (!v.moduleId || v.projectId || v.roundId)
        throw new Error("ARTIFACT_DENIED");
      // Discover only on explicit Skill entry. Free chat never calls this path.
      const entries = (await workbench.catalog(v.moduleId)).filter(
        (e) => e.moduleId === v.moduleId,
      );
      if (!entries.length) throw new Error("ARTIFACT_INVALID_WORKFLOW");
      const entry = v.registration
        ? entries.find((e) => e.id === v.registration)
        : entries.sort((a, b) => b.workflow.version - a.workflow.version)[0];
      if (!entry) throw new Error("ARTIFACT_INVALID_WORKFLOW");
      const existingProjects = await workbench.projects();
      // Social accounts keep one immutable project identity. A changed module
      // binding cannot silently duplicate it or rewrite historical Skill scope.
      if (entry.workflow.kind === "social" && v.account && existingProjects.some(p =>
        p.account === v.account && (p.skillId !== entry.skillId || p.moduleId !== v.moduleId)))
        throw new Error("ARTIFACT_ACCOUNT_CONFLICT");
      const projects = existingProjects.filter(
        (p) =>
          p.moduleId === v.moduleId &&
          p.skillId === entry.skillId &&
          (entry.workflow.kind !== "social" || p.account === v.account),
      );
      const project = projects[0];
      if (project) {
        const rounds = await workbench.rounds(project.projectId);
        const round =
          rounds.find((r) => r.state === "draft") ??
          rounds.filter((r) => r.state === "published").at(-1) ??
          rounds.at(-1);
        if (round)
          return chatBinding.parse(
            await call("attach", undefined, {
              projectId: project.projectId,
              roundId: round.roundId,
              requestId: v.requestId,
            }),
          );
      }
      // The request UUID fixes creation identity so repeated entry cannot create
      // orphan projects/rounds or duplicate conversations after lost responses.
      await workbench.start({
        projectId: v.requestId,
        roundId: v.requestId,
        requestId: v.requestId,
        registration: entry.id,
        account: v.account ?? null,
      }, v.moduleId);
      return chatBinding.parse(
        await call("attach", undefined, {
          projectId: v.requestId,
          roundId: v.requestId,
          requestId: v.requestId,
        }),
      );
    },
    async dismissSummary(input: z.infer<typeof chatScope> & { candidateId: string }) {
      return z.object({dismissed:z.literal(true)}).parse(await call("dismiss_summary",uuid.parse(input.conversationId),{candidateId:uuid.parse(input.candidateId)}));
    },
    async summary(input: z.infer<typeof chatScope> & { requestId: string }) {
      return z.object({requestId: uuid, turnId: uuid, stepId: z.string(), body: z.string()}).parse(
        await call("summary", uuid.parse(input.conversationId), {requestId: uuid.parse(input.requestId)}));
    },
    async read(input: z.infer<typeof chatScope>) {
      const { conversationId } = chatScope.parse(input);
      const data = await call("read", conversationId);
      return z
        .object({ binding: chatBinding, turns: chatTurn.array() })
        .parse(data);
    },
    async select(
      input: z.infer<typeof chatScope> & {
        stepId: string;
      },
    ) {
      return chatBinding.parse(
        await call("select", uuid.parse(input.conversationId), {
          stepId: input.stepId,
        }),
      );
    },
    async submit(input: z.infer<typeof chatTurnInput>) {
      const v = chatTurnInput.parse(input);
      checkInputSecurity(v.body);
      return z
        .object({ requestId: uuid })
        .parse(await call("submit", v.conversationId, v));
    },
  };
}
