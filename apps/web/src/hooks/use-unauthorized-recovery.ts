'use client';

import { useCallback, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { createClient } from '@/lib/supabase';
import {
  buildLoginPath,
  decideUnauthorizedAction,
  readLastAutoRedirect,
  recordAutoRedirect,
  type UnauthorizedNoticeReason,
} from '@/lib/auth-recovery';

// Handles API calls rejected as unauthenticated (see decideUnauthorizedAction). Only one recovery
// runs at a time; after a redirect or a notice it stays locked for the rest of the page load.
export function useUnauthorizedRecovery(
  supabase: ReturnType<typeof createClient>,
  queryClient: QueryClient,
) {
  const [notice, setNotice] = useState<UnauthorizedNoticeReason | null>(null);
  const [relogging, setRelogging] = useState(false);
  const lockedRef = useRef(false);
  const sessionRefreshUsedRef = useRef(false);

  const handleUnauthorized = useCallback(async () => {
    if (lockedRef.current) return;
    lockedRef.current = true;

    const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
    const now = Date.now();
    const action = decideUnauthorizedAction({
      pathname: window.location.pathname,
      search: window.location.search,
      hasSession: Boolean(data.user),
      sessionRefreshUsed: sessionRefreshUsedRef.current,
      lastRedirectAt: readLastAutoRedirect(),
      now,
    });

    switch (action.kind) {
      case 'ignore':
        lockedRef.current = false;
        return;
      case 'refresh':
        sessionRefreshUsedRef.current = true;
        await supabase.auth.refreshSession().catch(() => undefined);
        lockedRef.current = false;
        await queryClient.invalidateQueries({ refetchType: 'active' });
        return;
      case 'redirect':
        recordAutoRedirect(now);
        window.location.assign(action.to);
        return;
      case 'notice':
        setNotice(action.reason);
        return;
    }
  }, [queryClient, supabase]);

  const relogin = useCallback(async () => {
    setRelogging(true);
    await supabase.auth.signOut().catch(() => undefined);
    window.location.assign(buildLoginPath(window.location.pathname, window.location.search));
  }, [supabase]);

  return { notice, relogging, handleUnauthorized, relogin };
}
