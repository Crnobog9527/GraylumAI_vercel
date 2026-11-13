/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@/lib/supabase';
import { buildAppHref } from '@/lib/site-config';

/*
 * 退出 / 退出登录 on any signed-in page (the rail's profile panel, the profile center's menu and its phone list, the old
 * header) ends on the home page "/" (Owner 2026-11-13: "点击左侧边栏的'退出'，都让他们返回落地页去").
 *
 * Signing out empties the session and tells the provider (trpc/provider.tsx), which reads the open page's data again. Those
 * reads now carry no login, so the server refuses them, and the recovery from a refused call (hooks/use-unauthorized-recovery.ts)
 * used to send the browser to /login?redirect=<this page>. That move came after the one to the home page and, the home page
 * being slower to answer than a refusal, replaced it: the person who pressed 退出 landed on the login page. While a sign-out
 * that this page started is under way, such refusals are expected and nothing is to be recovered (isSigningOut).
 */
let signingOut = false;

/** Whether this page has started signing out and is on its way to the home page. */
export function isSigningOut(): boolean {
  return signingOut;
}

/**
 * Signs out and goes to the home page. `true` once the browser has been sent there; `false` when the sign-out could not be
 * carried out (or one is already under way), and then the page stays as it was, signed in.
 */
export async function signOutToHome(): Promise<boolean> {
  if (signingOut) return false;
  signingOut = true;
  try {
    await createClient().auth.signOut();
  } catch {
    signingOut = false;
    return false;
  }
  // A page kept by the browser and shown again by "back" is a signed-in page like any other: it recovers from a refusal as usual.
  window.addEventListener('pageshow', event => { if (event.persisted) signingOut = false; }, { once: true });
  window.location.href = buildAppHref('/');
  return true;
}
