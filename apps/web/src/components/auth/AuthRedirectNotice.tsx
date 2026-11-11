/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { buyIntentFromTarget, describeBuyIntent } from '@/lib/buyIntent';

/**
 * Where the login page returns to. A landing-page buy link names the plan; any other target is described in words,
 * never by its address (walkthrough 2026-11-11, item 9: the page showed "登录完成后将返回 /app/positioning").
 */
export function AuthRedirectNotice({ target }: { target: string }) {
  if (target === '/app/profile') return null;
  const intent = buyIntentFromTarget(target);
  return (
    <p className="rounded-xl border px-3 py-2 text-xs text-[var(--pub-body)]" style={{ borderColor: 'var(--pub-line)' }}
      data-testid="auth-redirect-notice">
      {intent
        ? <>注册或登录后，直接回到「开通 <span className="font-semibold">{describeBuyIntent(intent)}</span>」的付款确认</>
        : <>登录后会直接带你去刚才要打开的页面</>}
    </p>
  );
}
