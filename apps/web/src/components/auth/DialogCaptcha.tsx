'use client';

import { useEffect, useRef } from 'react';
import { getAuthCaptchaSiteKey } from '@/lib/authCaptcha';
import { loadHCaptcha, renderDialogCaptcha } from '@/lib/dialogCaptcha';

type Props = {
  onToken: (token: string | null) => void;
  onExpired: () => void;
  onUnavailable: () => void;
};

/**
 * hCaptcha rendered inside a dialog. Remount it (change its React key) after every attempt so the
 * next attempt needs a fresh token. Renders nothing when CAPTCHA is not configured.
 */
export function DialogCaptcha({ onToken, onExpired, onUnavailable }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onExpired, onUnavailable });
  handlers.current = { onToken, onExpired, onUnavailable };
  const siteKey = getAuthCaptchaSiteKey();

  useEffect(() => {
    if (!siteKey || !container.current) {
      return undefined;
    }
    const target = container.current;
    let cancelled = false;
    let remove: (() => void) | undefined;
    loadHCaptcha()
      .then((client) => {
        if (cancelled) return;
        remove = renderDialogCaptcha(client, target, siteKey, {
          onToken: (token) => handlers.current.onToken(token),
          onExpired: () => handlers.current.onExpired(),
        });
      })
      .catch(() => {
        if (!cancelled) handlers.current.onUnavailable();
      });
    return () => {
      cancelled = true;
      remove?.();
      handlers.current.onToken(null);
    };
  }, [siteKey]);

  if (!siteKey) {
    return null;
  }
  return <div ref={container} data-dialog-captcha="" className="min-h-[78px]" />;
}
