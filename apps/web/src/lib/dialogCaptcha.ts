import {
  getAuthCaptchaSiteKey,
  HCAPTCHA_SCRIPT_SRC,
  type AuthCaptchaOptions,
  type HCaptchaClient,
} from '@/lib/authCaptcha';

// Widgets inside dialogs mount after the page loaded, so hCaptcha's implicit page-load scan never
// sees them; they are rendered explicitly into the dialog instead.
export const CAPTCHA_REQUIRED_MESSAGE = '请完成人机验证后重试。';
export const CAPTCHA_EXPIRED_MESSAGE = '人机验证已过期，请重新验证。';
const SCRIPT_ID = 'graylum-hcaptcha-explicit';

type LoaderEnv = { doc: Document; win: Window };

export function loadHCaptcha(env: LoaderEnv = { doc: document, win: window }): Promise<HCaptchaClient> {
  const ready = () => (env.win.hcaptcha?.render ? env.win.hcaptcha : null);
  const loaded = ready();
  if (loaded) {
    return Promise.resolve(loaded);
  }
  return new Promise((resolve, reject) => {
    let script = env.doc.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = env.doc.createElement('script');
      script.id = SCRIPT_ID;
      script.src = `${HCAPTCHA_SCRIPT_SRC}?render=explicit`;
      script.async = true;
      env.doc.head.appendChild(script);
    }
    const loading = script;
    // A failed element never fires again; remove it so the next call inserts and loads afresh.
    const fail = () => {
      loading.remove();
      reject(new Error('hCaptcha unavailable'));
    };
    loading.addEventListener('load', () => {
      const client = ready();
      if (client) resolve(client);
      else fail();
    }, { once: true });
    loading.addEventListener('error', fail, { once: true });
  });
}

export type CaptchaHandlers = {
  onToken: (token: string | null) => void;
  onExpired: () => void;
};

/** Renders one widget; returns a cleanup that removes it (a remount gives a fresh, unused token). */
export function renderDialogCaptcha(
  client: HCaptchaClient,
  container: HTMLElement,
  siteKey: string,
  handlers: CaptchaHandlers,
): () => void {
  if (!client.render) {
    throw new Error('hCaptcha explicit rendering unavailable');
  }
  const widgetId = client.render(container, {
    sitekey: siteKey,
    callback: (token) => handlers.onToken(token),
    'expired-callback': () => {
      handlers.onToken(null);
      handlers.onExpired();
    },
    'error-callback': () => handlers.onToken(null),
  });
  return () => client.remove?.(widgetId);
}

/** Auth options for one attempt; the caller discards the token afterwards (single use). */
export function captchaOptionsFromToken(
  token: string | null,
  siteKey: string = getAuthCaptchaSiteKey(),
): AuthCaptchaOptions {
  if (!siteKey) {
    return {};
  }
  if (!token) {
    throw new Error(CAPTCHA_REQUIRED_MESSAGE);
  }
  return { captchaToken: token };
}

export function isHCaptchaSource(src: string | null | undefined): boolean {
  if (!src) return false;
  try {
    const host = new URL(src, 'https://invalid.local').hostname;
    return host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com');
  } catch {
    return false;
  }
}

const isHCaptchaFrame = (el: Element) => el.tagName === 'IFRAME' && isHCaptchaSource(el.getAttribute('src'));

/**
 * hCaptcha mounts its image challenge outside the dialog (a direct child of <body>). A pointer or
 * focus event there must not dismiss the dialog, or the widget unmounts mid-challenge. Matched by
 * the hCaptcha frame source, never by element ids; the dialog's own portal (overlay + content)
 * is excluded so a click on the overlay still closes the dialog.
 */
export function isCaptchaChallengeTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  let top = target as Element;
  const body = top.ownerDocument?.body ?? null;
  if (isHCaptchaFrame(top)) return true;
  while (top.parentElement && top.parentElement !== body) {
    top = top.parentElement;
    if (isHCaptchaFrame(top)) return true;
  }
  if (top.querySelector('[role="dialog"]')) return false;
  return Array.from(top.querySelectorAll('iframe')).some(isHCaptchaFrame);
}

/** Pass as onInteractOutside of a dialog that renders DialogCaptcha. */
export function keepDialogOpenForCaptcha(event: { target: EventTarget | null; preventDefault: () => void }) {
  if (isCaptchaChallengeTarget(event.target)) event.preventDefault();
}
