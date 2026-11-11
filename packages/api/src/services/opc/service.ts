/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { draftReadWithModule } from "./readonlyDraft";
import {StagingAccessError} from "../turn/settings/stagingErrors";
import { throwOpcRpcError } from "./contentBindingError";
import { capturePending, capturePendingInput, captureResolveInput } from "./capture";
import { opcInformation } from "./information";
export { opcInformation } from "./information";
import { z } from "zod";
import {dataFoundationService} from "./dataFoundation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEmailVerified } from "../../lib/auth";
import { workbenchService } from "../artifacts/workbench";
import type {StagingPolicy} from '../turn/settings/stagingPolicy';
import { turnContentService } from './turnContent';
import { opcPlan, opcHandoff, opcLibraryEdit, opcVideoMaterialPrepare } from "../../shared/opcRequests";
export { planItem, opcPlan, opcHandoff, opcTopicTurn, opcTopicDraft, opcAdoptTopics, opcLibraryEdit, opcContentFromExecution, opcContentFromTurn, opcContentManualSave, opcVideoPackage, opcVideoResults, opcVideoResultsFromTurn, opcVideoExecutionCheck, opcVideoMaterialPrepare } from "../../shared/opcRequests";
const uuid = z.string().uuid();
import {opcTopicBind, startWithPositioningProfileLimit} from './start';
import {isPositioningWorkflow} from './positioningWorkflow';
export {opcStart, opcTopicBind} from './start';
/**
 * `verifiedActorId`: the signed-in account the tRPC procedure has already verified for this request (login and verified
 * email, protectedProcedure). With it no query asks the session again: one draft read used to verify the same session three
 * more times. Without it (scripts and tests that build the service from the clients alone) every query verifies the session.
 */
export function opcService(user: SupabaseClient, admin: SupabaseClient, real?:StagingPolicy, verifiedActorId?: string) {
  const sessionActor = async () => verifiedActorId ?? (await user.auth.getUser()).data.user?.id;
  async function rpc(name: string, args: Record<string, unknown>, actorId: string | undefined = verifiedActorId) {
    const a = actorId ? null : await user.auth.getUser();
    if (!actorId && (a?.error || !a?.data.user || !isEmailVerified(a.data.user)))
      throw new Error("OPC_AUTH_REQUIRED");
    const r = await admin
      .rpc(name, { ...args, p_actor_id: actorId ?? a!.data.user!.id })
      .abortSignal(AbortSignal.timeout(10000));
    if (r.error?.message === "RUNTIME_ORGANIZER_PENDING") throw new StagingAccessError('RUNTIME_ORGANIZER_PENDING');
    if (r.error) throwOpcRpcError(r.error);
    return r.data;
  }
  return {
    ...dataFoundationService(rpc),
    capturePending: (value: unknown) => capturePending(rpc, capturePendingInput.parse(value).draftId),
    captureResolve: (value: unknown) => {
      const v = captureResolveInput.parse(value);
      return rpc("opc_capture_resolve", {
        p_draft_id: v.draftId, p_request_id: v.requestId, p_step_id: v.stepId,
        p_field_id: v.fieldId, p_execution_id: v.executionId, p_hash: v.hash,
        p_action: v.action, p_expected_version: v.expectedVersion,
      });
    },
    information: async (value: unknown) => {
      const v = opcInformation.parse(value);
      return rpc("opc_information", {
        p_draft_id: v.draftId,
        p_step_id: v.stepId,
        p_request_id: v.requestId,
        p_expected_version: v.expectedVersion,
        p_values: v.values,
      });
    },
    revise: (draftId: string, requestId: string, expectedRoundId: string) =>
      rpc("opc_revise", {
        p_draft_id: uuid.parse(draftId),
        p_request_id: uuid.parse(requestId),
        p_expected_round_id: uuid.parse(expectedRoundId),
      }),
    saveWorkResult: (id: { turnId: number }) => rpc("opc_work_result_turn", { p_turn_id: id.turnId }),
    workResults: (sessionId: string) =>
      rpc("opc_work_results", { p_session_id: uuid.parse(sessionId) }),
    catalog: async () => {
      // The positioning rule reads workflow fields the parsed registrations drop, so it runs on the rows of the same catalog
      // read (the catalog used to be queried a second time for them).
      let rows: Array<{ id?: unknown; workflow?: unknown }> = [];
      const catalog = await workbenchService(user, admin, verifiedActorId).catalog(undefined, (raw) => {
        if (Array.isArray(raw)) rows = raw;
      });
      return catalog.filter((c) =>
        rows.some((r) => r.id === c.id && isPositioningWorkflow(r.workflow)),
      );
    },
    list: () => rpc("opc_query", {}),
    /**
     * The persisted topic workspace of one draft: which confirmed positioning
     * version and which pinned method revision it is bound to. It is read from
     * the server, never inferred from client storage.
     */
    topicRead: (draftId: string) =>
      rpc("opc_topic_read", { p_draft_id: uuid.parse(draftId) }),
    /**
     * One explicit, idempotent bind of the draft's topic workspace. The server
     * freezes the source version, the pinned revision and its declared topic
     * resources; it fails closed instead of inventing a topic Skill.
     */
    topicConsent: (value: unknown) => {
      const v = opcTopicBind.omit({ requestId: true }).parse(value);
      return rpc("opc_topic_consent", { p_draft_id: v.draftId, p_source_version_id: v.sourceVersionId });
    },
    read: async (draftId: string) => ({...await draftReadWithModule(await rpc("opc_query", {p_draft_id: uuid.parse(draftId)}), rpc, sessionActor, admin),
      runtimeMode:real?(real.mode==="production"?"production":"staging_test"):"isolated"}),
    start: (value: unknown) => startWithPositioningProfileLimit(value,user,admin,rpc),
    topicDraftRead: (draftId: string) => rpc("opc_topic_draft_read", { p_draft_id: uuid.parse(draftId) }),
    library: (value: unknown) => {
      const v = z.object({
        search: z.string().max(160).default(""),
        from: z.string().date().nullable().default(null),
        to: z.string().date().nullable().default(null),
      }).strict().parse(value);
      return rpc("opc_library", { p_search: v.search, p_from: v.from, p_to: v.to });
    },
    workUiChange: (value: unknown) => {
      const v = z.object({workItemId:uuid,requestId:uuid,expectedRevision:z.number().int().positive(),action:z.enum(['rename','pin','unpin','archive','restore','delete']),name:z.string().trim().min(1).max(160).optional()}).strict().parse(value);
      return rpc('opc_work_ui_change',{p_work_item_id:v.workItemId,p_request_id:v.requestId,p_expected_revision:v.expectedRevision,p_action:v.action,p_name:v.name??null});
    },
    accountUiChange: (value: unknown) => {
      const v=z.object({accountProjectId:uuid,requestId:uuid,expectedRevision:z.number().int().positive(),name:z.string().trim().min(1).max(120)}).strict().parse(value);
      return rpc('opc_account_ui_change',{p_account_project_id:v.accountProjectId,p_request_id:v.requestId,p_expected_revision:v.expectedRevision,p_name:v.name});
    },
    publicationUiChange: (value: unknown) => {
      const v=z.object({workItemId:uuid,requestId:uuid,expectedRevision:z.number().int().positive(),plannedDate:z.string().date().nullable(),status:z.enum(['unpublished','published']),publishedDate:z.string().date().nullable()}).strict().parse(value);
      return rpc('opc_publication_ui_change',{p_work_item_id:v.workItemId,p_request_id:v.requestId,p_expected_revision:v.expectedRevision,p_planned_date:v.plannedDate,p_status:v.status,p_published_date:v.publishedDate});
    },
    accountStrategyHistory: (accountProjectId:string) => rpc('opc_account_strategy_history',{p_account_project_id:uuid.parse(accountProjectId)}),
    accountStrategySchema: (accountProjectId:string) => rpc('opc_account_strategy_schema',{p_account_project_id:uuid.parse(accountProjectId)}),
    accountStrategyBegin: (accountProjectId:string,requestId:string) => rpc('opc_account_strategy_begin',{p_account_project_id:uuid.parse(accountProjectId),p_request_id:uuid.parse(requestId)}),
    accountStrategySave: (value:unknown) => {
      const v=z.object({accountProjectId:uuid,requestId:uuid,expectedSourceVersionId:uuid,expectedPendingDraftId:uuid.nullable(),expectedRegistrationId:z.string().min(1).max(100).nullable().optional(),expectedStepVersions:z.record(z.string().max(64),z.number().int().nonnegative()).nullable().optional(),edits:z.record(z.string().max(64),z.record(z.string().max(64),z.string().max(400)))}).strict().parse(value);
      return rpc('opc_account_strategy_save_checked',{p_account_project_id:v.accountProjectId,p_request_id:v.requestId,p_expected_source_version_id:v.expectedSourceVersionId,p_expected_pending_draft_id:v.expectedPendingDraftId,p_expected_registration_id:v.expectedRegistrationId??null,p_expected_step_versions:v.expectedStepVersions??null,p_edits:v.edits});
    },
    libraryEdit: (value: unknown) => {
      const v = opcLibraryEdit.parse(value);
      return rpc("opc_library_edit", {
        p_request_id: v.requestId,
        p_target: v.target,
        p_target_id: v.targetId,
        p_expected_revision: v.expectedRevision,
        p_patch: v.patch,
      });
    },
    ...turnContentService(rpc),
    videoMaterialPrepare: (value: unknown) => {
      const v = opcVideoMaterialPrepare.parse(value);
      return rpc("opc_video_material_prepare", {
        p_work_item_id: v.workItemId,
        p_request_id: v.requestId,
        p_source_script_id: v.sourceScriptId,
        p_storyboard: v.action !== "abandon" && (v.choice === "both" || v.choice === "storyboard"),
        p_editing: v.action !== "abandon" && (v.choice === "both" || v.choice === "editing"),
        p_expected_storyboard_version: v.expectedStoryboardVersion,
        p_expected_editing_version: v.expectedEditingVersion,
      });
    },
    savePlan: async (value: unknown) => {
      const v = opcPlan.parse(value);
      return rpc("opc_save_plan", {
        p_draft_id: v.draftId,
        p_request_id: v.requestId,
        p_expected_version: v.expectedVersion,
        p_source_version_id: v.sourceVersionId,
        p_body: v.body,
      });
    },
    handoff: async (value: unknown) => {
      const v = opcHandoff.parse(value);
      return rpc("opc_handoff_b1", {
        p_draft_id: v.draftId,
        p_request_id: v.requestId,
        p_plan_id: v.planId,
        p_accounts: v.accounts,
      });
    },
  };
}
