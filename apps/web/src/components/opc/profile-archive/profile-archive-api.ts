/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { isDraftArchived } from './profile-archive';

/** The caller's non-erased profiles (`opc.businesses`). */
export function useProfileBusinesses(enabled = true) {
  const query = trpc.opc.businesses.useQuery(undefined, { enabled, retry: false, staleTime: 15_000, refetchOnWindowFocus: true });
  return { ...query, businesses: Array.isArray(query.data) ? query.data : undefined };
}

export type DraftArchiveState = 'pending' | 'error' | 'active' | 'archived';

/**
 * Whether this draft's profile is archived. "Unknown" is never "active": while the profile read is pending or failed
 * the caller keeps the editable page closed (#1217 review), so nothing can be sent before the state is confirmed.
 */
export function useDraftArchiveState(draftId: string, enabled = true) {
  const profiles = useProfileBusinesses(enabled);
  const state: DraftArchiveState = profiles.error ? 'error' : !profiles.businesses ? 'pending'
    : isDraftArchived(profiles.businesses, draftId) ? 'archived' : 'active';
  return { state, retry: () => void profiles.refetch() };
}

/** tRPC v11 query key prefix of `opc.businesses`, for invalidation outside a component. */
export const PROFILE_BUSINESSES_KEY = [['opc', 'businesses']] as const;
