export const HCAPTCHA_SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js';

type HCaptchaClient = {
  getResponse: (widgetId?: number) => string;
  reset: (widgetId?: number) => void;
};

export type AuthCaptchaOptions = {
  captchaToken?: string;
};

declare global {
  interface Window {
    hcaptcha?: HCaptchaClient;
  }
}

export function getAuthCaptchaSiteKey() {
  return process.env.NEXT_PUBLIC_HCAPTCHA_SITEKEY?.trim() ?? '';
}

export function getAuthCaptchaToken(widgetId?: number): string | undefined {
  if (!getAuthCaptchaSiteKey()) {
    return undefined;
  }

  if (typeof window === 'undefined') {
    throw new Error('人机验证暂不可用，请稍后重试。');
  }

  const token = window.hcaptcha?.getResponse(widgetId)?.trim();
  if (!token) {
    throw new Error('请完成人机验证后重试。');
  }

  return token;
}

export function getAuthCaptchaOptions(widgetId?: number): AuthCaptchaOptions {
  const token = getAuthCaptchaToken(widgetId);
  return token ? { captchaToken: token } : {};
}

export function resetAuthCaptcha(widgetId?: number) {
  if (!getAuthCaptchaSiteKey() || typeof window === 'undefined') {
    return;
  }

  window.hcaptcha?.reset(widgetId);
}

export async function runAuthCaptchaAttempt<T>(
  options: AuthCaptchaOptions,
  operation: (options: AuthCaptchaOptions) => Promise<T>,
  widgetId?: number,
): Promise<T> {
  try {
    return await operation(options);
  } finally {
    resetAuthCaptcha(widgetId);
  }
}
