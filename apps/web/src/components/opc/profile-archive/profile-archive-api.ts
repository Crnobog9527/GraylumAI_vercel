/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { isArchivedBusiness, type ProfileBusiness, type ProfileDraft } from './profile-archive';

/**
 * The two profile-archive procedures (PR #1215 handoff: `opc.businesses`, `opc.archiveBusiness({businessId})`).
 * Until that backend is merged they are not part of AppRouter's type, so they are reached through this one
 * narrow cast; nothing else in the page depends on it.
 */
type ArchiveHooks = {
  businesses: { useQuery: (input: undefined, options: { enabled?: boolean; retry: boolean; staleTime: number;
    refetchOnWindowFocus: boolean }) => { data?: unknown; error: unknown; isPending: boolean; isSuccess: boolean;
    refetch: () => Promise<unknown> } };
  archiveBusiness: { useMutation: () => { mutateAsync: (input: { businessId: string }) => Promise<unknown>; isPending: boolean } };
};
const opc = trpc.opc as unknown as ArchiveHooks;

/** Accepts either a bare list or `{ businesses }`, and drops rows that are not profiles. */
export function readBusinesses(data: unknown): ProfileBusiness[] {
  const list = Array.isArray(data) ? data : (data as { businesses?: unknown } | null)?.businesses;
  if (!Array.isArray(list)) return [];
  return list.filter((row): row is ProfileBusiness => Boolean(row) && typeof row === 'object'
    && typeof (row as ProfileBusiness).businessId === 'string' && typeof (row as ProfileBusiness).isArchived === 'boolean');
}

/** The caller's non-erased profiles. A failed read shows nothing as archived, and the server still refuses writes. */
export function useProfileBusinesses(enabled = true) {
  const query = opc.businesses.useQuery(undefined, { enabled, retry: false, staleTime: 15_000, refetchOnWindowFocus: true });
  return { ...query, businesses: query.isSuccess ? readBusinesses(query.data) : undefined };
}

/**
 * Whether the draft's profile is archived, from the drafts list (`opc.list`, which names each draft's business) and
 * `opc.businesses`. While either is unknown the draft is treated as active; the server refuses writes either way.
 */
export function useDraftArchived(draftId: string, list: unknown): boolean {
  const profiles = useProfileBusinesses();
  const drafts = (list as { drafts?: ProfileDraft[] } | null | undefined)?.drafts ?? [];
  return isArchivedBusiness(profiles.businesses, drafts.find(draft => draft.draftId === draftId)?.businessId);
}

export function useArchiveBusiness() {
  return opc.archiveBusiness.useMutation();
}

/** tRPC v11 query key prefix of `opc.businesses`, for invalidation outside a component. */
export const PROFILE_BUSINESSES_KEY = [['opc', 'businesses']] as const;
