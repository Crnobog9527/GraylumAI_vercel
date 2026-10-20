/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * PAYWALL profile archive (Owner 2026-10-20: "档案归档释放名额现在就补"). An archived positioning profile
 * (one `opc_businesses` row) is read-only, can still be viewed and exported, no longer counts against the
 * Free 1 / Pro 3 / Gold 6 allowance, and cannot be restored. The server decides all of this; these helpers
 * only shape `opc.businesses` for display and recognise the server's refusal code.
 */
export type ProfileBusiness = { businessId: string; name?: string | null; archivedAt?: string | null; isArchived: boolean;
  /** The caller's non-deleted positioning drafts of this profile (`opc.businesses`, #1215). */
  drafts?: ReadonlyArray<{ draftId: string }> };
export type ProfileDraft = { draftId: string; createdAt?: string | null };
export type ProfileRow = ProfileBusiness & { draftId: string | null };

/** The server's refusal for any write or paid start on an archived profile. */
export const PROFILE_ARCHIVED_CODE = 'OPC_BUSINESS_ARCHIVED';

export const PROFILE_ARCHIVE_TEXT = {
  title: '我的定位档案',
  usage: (used: number, limit: number) => `已用 ${used}/${limit} 个名额`,
  unnamed: '未命名档案',
  open: '打开',
  view: '查看',
  archive: '归档',
  archiving: '正在归档…',
  archivedGroup: (count: number) => `已归档（${count}）`,
  archivedTag: '只读',
  noDraft: '暂无可查看的内容',
  empty: '还没有定位档案。',
  confirmTitle: '归档这个定位档案？',
  confirmBody: '归档后只能查看和导出，不能再继续对话或生成报告。会释放 1 个名额，归档后不能恢复。',
  confirm: '确认归档',
  cancel: '先不归档',
  archived: '已归档，空出了 1 个名额。',
  archiveFailed: '归档没成功，请稍后再试。',
  archiveBusy: '这个档案还有操作在进行，等它完成后再归档。',
  archiveGone: '这个档案已经不在了，列表已刷新。',
  loadFailed: '定位档案暂时读不出来，请稍后再试。',
  limitReached: '定位档案名额用完了。把不再更新的档案归档，就能空出名额；也可以升级会员。',
  limitHint: '名额用完了，可以把不再更新的档案归档。',
  readonlyTitle: '定位分析（已归档）',
  readonlyNotice: '这个定位档案已归档，只能查看和导出，不能继续对话或生成报告。',
  archivedRefusal: '这个定位档案已经归档了，只能查看和导出，不能继续对话或生成报告。刷新页面就能看到只读版本。',
  report: '定位报告',
} as const;

/** True for the server's archived-profile refusal, whatever layer wrapped it. */
export function isProfileArchivedError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.message.includes(PROFILE_ARCHIVED_CODE)) return true;
  const code = (cause as { code?: unknown }).code;
  return code === PROFILE_ARCHIVED_CODE;
}

/**
 * Whether the draft belongs to an archived profile, by the profile's own draft list (#1215: archive state is mapped
 * from `opc.businesses` and its `drafts`, never from the conversation-deleted flag). Unknown is not archived.
 */
export function isDraftArchived(businesses: readonly ProfileBusiness[] | undefined, draftId: string): boolean {
  return Boolean(businesses?.some(business => business.isArchived && business.drafts?.some(draft => draft.draftId === draftId)));
}

/**
 * Active and archived profiles, each with the draft that opens it: of the profile's own drafts, the newest by the
 * drafts list (`opc.list` createdAt), or its first one while that list is unknown. Active ones keep the server's
 * order; archived ones show the most recently archived first.
 */
export function splitProfiles(businesses: readonly ProfileBusiness[] | undefined, drafts: readonly ProfileDraft[] | undefined) {
  const created = new Map((drafts ?? []).map(draft => [draft.draftId, draft.createdAt ?? '']));
  const opens = (business: ProfileBusiness) => (business.drafts ?? []).map(draft => draft.draftId)
    .reduce<string | null>((best, id) => best === null || (created.get(id) ?? '') > (created.get(best) ?? '') ? id : best, null);
  const rows: ProfileRow[] = (businesses ?? []).map(business => ({ ...business, draftId: opens(business) }));
  return {
    active: rows.filter(row => !row.isArchived),
    archived: rows.filter(row => row.isArchived).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
  };
}

export const profileName = (row: { name?: string | null }) => row.name?.trim() || PROFILE_ARCHIVE_TEXT.unnamed;
