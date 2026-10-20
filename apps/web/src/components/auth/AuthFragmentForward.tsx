/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { readAuthFragment } from '@/lib/authFlow';

/**
 * Where a GoTrue answer in the URL fragment should go. When GoTrue does not accept a requested redirect it falls
 * back to the Site URL root, and a link sent without PKCE answers there in the fragment, which the server never
 * sees. The root is the public home page since the /app move (E1), so the answer is handed to the login page,
 * which reads it (readAuthFragment) as it did when the root still needed login.
 */
export function authFragmentForwardTarget(hash: string): string | null {
  return readAuthFragment(hash) ? `/login${hash}` : null;
}

export function AuthFragmentForward() {
  useEffect(() => {
    const target = authFragmentForwardTarget(window.location.hash);
    if (target) window.location.replace(target);
  }, []);
  return null;
}
