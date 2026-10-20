/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { isDraftArchived } from './profile-archive';

/** The caller's non-erased profiles (`opc.businesses`). A failed read shows nothing as archived; the server still refuses writes. */
export function useProfileBusinesses(enabled = true) {
  const query = trpc.opc.businesses.useQuery(undefined, { enabled, retry: false, staleTime: 15_000, refetchOnWindowFocus: true });
  return { ...query, businesses: query.data };
}

/** Whether this draft's profile is archived. While unknown the draft is treated as active. */
export function useDraftArchived(draftId: string): boolean {
  return isDraftArchived(useProfileBusinesses().businesses, draftId);
}

/** tRPC v11 query key prefix of `opc.businesses`, for invalidation outside a component. */
export const PROFILE_BUSINESSES_KEY = [['opc', 'businesses']] as const;
