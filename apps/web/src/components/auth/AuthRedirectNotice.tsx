/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { buyIntentFromTarget, describeBuyIntent } from '@/lib/buyIntent';

/** Where the login page returns to. A landing-page buy link names the plan instead of showing the raw path. */
export function AuthRedirectNotice({ target }: { target: string }) {
  if (target === '/profile') return null;
  const intent = buyIntentFromTarget(target);
  return (
    <p className="rounded-xl border px-3 py-2 text-xs text-[#c8c8c8]" style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      data-testid="auth-redirect-notice">
      {intent
        ? <>注册或登录后，直接回到「开通 <span className="font-semibold">{describeBuyIntent(intent)}</span>」的付款确认</>
        : <>登录完成后将返回 <span className="font-mono">{target}</span></>}
    </p>
  );
}
