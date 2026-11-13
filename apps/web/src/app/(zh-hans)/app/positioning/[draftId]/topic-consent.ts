/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from "@/trpc/client";

/**
 * "继续生成第一周选题": the explicit consent that enters the bound topic workspace. Without React so the rule is testable: the
 * server binds the topic workspace to the version the page shows (under its own lock), and only an answer that names exactly that
 * version lets the page go to /topics. Any refusal stays on the page with a fixed notice; nothing is dispatched here (the
 * workspace's own turn is the paid action).
 */
export const TOPIC_SOURCE_CHANGED_NOTICE = "当前定位版本与原选题工作空间来源不同，已停止进入。原对话和计划保留，请从历史入口核对原来源。";
export const TOPIC_SKILL_MISSING_NOTICE = "当前定位方法没有声明可用的选题资源，无法开始；本次没有模型调用。";
export const TOPIC_UNVERIFIED_NOTICE = "暂时无法核实选题同意状态，请重试原入口；不会创建第二次首轮意图。";

export function topicConsentNotice(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  return message.includes("OPC_TOPIC_SOURCE_CHANGED") || message.includes("OPC_TOPIC_BOUND") ? TOPIC_SOURCE_CHANGED_NOTICE
    : message.includes("OPC_TOPIC_SKILL_MISSING") ? TOPIC_SKILL_MISSING_NOTICE : TOPIC_UNVERIFIED_NOTICE;
}

export async function enterTopicWorkspace(deps: {
  draftId: string;
  /** The version the page shows (`d.report?.id`); an empty source is sent as "" and never matches an answer. */
  sourceVersionId: string | undefined;
  bind: (input: { draftId: string; sourceVersionId: string }) => Promise<{ bound: boolean; sourceVersionId?: string | null }>;
  push: (path: string) => void;
}): Promise<{ entered: true } | { entered: false; notice: string }> {
  try {
    const accepted = await deps.bind({ draftId: deps.draftId, sourceVersionId: deps.sourceVersionId ?? "" });
    if (!accepted.bound || accepted.sourceVersionId !== deps.sourceVersionId) throw new Error("OPC_TOPIC_SOURCE_CHANGED");
    deps.push(`/app/positioning/${deps.draftId}/topics`);
    return { entered: true };
  } catch (cause) {
    return { entered: false, notice: topicConsentNotice(cause) };
  }
}

/**
 * Whether the report page shows "进入选题工作对话 →". A formal report of this round, or a topic workspace already bound to the version in
 * effect: while a revision is open the round has no report yet, but the bound workspace keeps working on the confirmed version
 * (topic_turn_source checks only that it is still the current one), so its entry stays (staging validation #1269).
 */
export function topicsEntryShown(reportAvailable: boolean | undefined, workspaceBound: boolean | undefined): boolean {
  return Boolean(reportAvailable || workspaceBound);
}

/** The report page's one call: reads whether the topics window is bound (only for a draft whose conversation still exists). */
export function useTopicsEntry(draftId: string, read: { conversationDeleted?: boolean; report?: { available?: boolean } | null } | undefined) {
  const workspace = trpc.opc.topicWorkspace.useQuery({ draftId },
    { enabled: Boolean(draftId && read && !read.conversationDeleted), staleTime: 30_000 });
  return topicsEntryShown(read?.report?.available, workspace.data?.bound);
}
