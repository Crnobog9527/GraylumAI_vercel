import { getAuthCaptchaSiteKey, type AuthCaptchaOptions } from '@/lib/authCaptcha';
import { guardCaptchaFocus, HCAPTCHA_SCRIPT_ID, loadHCaptcha } from '@/lib/dialogCaptcha';

// Invisible hCaptcha (Owner 2026-09-30): no checkbox; hCaptcha scores the visitor in the
// background and shows a challenge only when it considers one necessary. Used for sign-in,
// sign-up, verification e-mail and password change. Account erasure keeps the visible checkbox.

const ERROR_TEXT: Record<string, string> = {
  'challenge-closed': '人机验证已取消，请重试。',
  'challenge-expired': '人机验证已超时，请重试。',
  'rate-limited': '操作太频繁，请稍后再试。',
  'network-error': '网络异常，人机验证未完成，请重试。',
};
export const CAPTCHA_UNAVAILABLE_MESSAGE = '人机验证暂不可用，请稍后重试。';
export const CAPTCHA_FAILED_MESSAGE = '人机验证未完成，请重试。';
// The script now loads on submit; a request that neither loads nor errors (slow or disrupted
// network) must not leave the submit button spinning. Only loading is bounded: execute may be
// waiting on a person solving a challenge, and hCaptcha ends that itself with challenge-expired.
export const CAPTCHA_LOAD_TIMEOUT_MS = 15_000;

function loadWithTimeout(env: Env, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Drop the stalled element so the next attempt inserts a fresh one (unless it did load).
      if (!env.win.hcaptcha?.render) env.doc.getElementById(HCAPTCHA_SCRIPT_ID)?.remove();
      reject(new Error('hCaptcha load timeout'));
    }, timeoutMs);
  });
  return Promise.race([loadHCaptcha(env), timeout]).finally(() => clearTimeout(timer));
}

export function describeCaptchaError(error: unknown): string {
  const code = typeof error === 'string' ? error : (error as { message?: string } | null)?.message ?? '';
  return ERROR_TEXT[code] ?? CAPTCHA_FAILED_MESSAGE;
}

type Env = { doc: Document; win: Window };

/**
 * One token per attempt: renders a fresh invisible widget, executes it, and removes it again.
 * While it runs, focus may move into a challenge even inside a modal dialog (guardCaptchaFocus).
 * Returns {} when CAPTCHA is not configured; throws an Error with a user-facing message.
 */
export async function invisibleCaptchaOptions(
  env: Env = { doc: document, win: window },
  siteKey: string = getAuthCaptchaSiteKey(),
  timeoutMs: number = CAPTCHA_LOAD_TIMEOUT_MS,
): Promise<AuthCaptchaOptions> {
  if (!siteKey) {
    return {};
  }
  let client;
  try {
    client = await loadWithTimeout(env, timeoutMs);
  } catch {
    throw new Error(CAPTCHA_UNAVAILABLE_MESSAGE);
  }
  if (!client.render || !client.execute) {
    throw new Error(CAPTCHA_UNAVAILABLE_MESSAGE);
  }
  const holder = env.doc.createElement('div');
  holder.setAttribute('data-invisible-captcha', '');
  env.doc.body.appendChild(holder);
  const releaseFocus = guardCaptchaFocus(env.win);
  let widgetId: number | undefined;
  try {
    widgetId = client.render(holder, { sitekey: siteKey, size: 'invisible' });
    const { response } = await client.execute(widgetId, { async: true });
    if (!response) throw new Error(CAPTCHA_FAILED_MESSAGE);
    return { captchaToken: response };
  } catch (error) {
    throw new Error(describeCaptchaError(error));
  } finally {
    releaseFocus();
    if (widgetId !== undefined) client.remove?.(widgetId);
    holder.remove();
  }
}
