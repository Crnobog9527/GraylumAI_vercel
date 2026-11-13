/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Whether the user has a confirmed positioning, by their own drafts (`opc.list`). One rule for every page that asks: the
 * positioning page's topic entries, the publish schedule's empty page (#1915), the start page's guide (#1909) and the
 * signed-in home page's two buttons. A draft counts as confirmed when it is published, or is a revision of one that was
 * published before (its `currentVersion` is above 0). While the list is being read, or cannot be read, nothing is known and
 * the user is treated as an existing one: nobody is led to start a second positioning on a guess.
 */
export type DraftsRead = { isPending: boolean; error: unknown; data?: unknown };
type Draft = { draftId?: string; state?: string; currentVersion?: number };

export const draftConfirmed = (draft: Draft) => draft.state === 'published' || (draft.currentVersion ?? 0) > 0;

const answered = (drafts: DraftsRead): Draft[] | null => {
  if (drafts.isPending || drafts.error) return null;
  const list = (drafts.data as { drafts?: Draft[] } | undefined)?.drafts;
  return Array.isArray(list) ? list : null;
};

/** The list was read and holds no confirmed positioning. */
export function isNewUser(drafts: DraftsRead): boolean {
  const list = answered(drafts);
  return list !== null && !list.some(draftConfirmed);
}

/** The first confirmed positioning the list holds, or null when there is none or the list is not known. */
export function confirmedDraftId(drafts: DraftsRead): string | null {
  return answered(drafts)?.find(draftConfirmed)?.draftId ?? null;
}
