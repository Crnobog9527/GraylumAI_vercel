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
    script.addEventListener('load', () => {
      const client = ready();
      if (client) resolve(client);
      else reject(new Error('hCaptcha unavailable'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('hCaptcha unavailable')), { once: true });
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
