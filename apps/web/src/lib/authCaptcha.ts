export const HCAPTCHA_SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js';

type HCaptchaClient = {
  getResponse: (widgetId?: number) => string;
};

declare global {
  interface Window {
    hcaptcha?: HCaptchaClient;
  }
}

export function getAuthCaptchaSiteKey() {
  return process.env.NEXT_PUBLIC_HCAPTCHA_SITEKEY ?? '';
}

export function getAuthCaptchaToken(widgetId?: number) {
  if (typeof window === 'undefined') {
    throw new Error('人机验证暂不可用，请稍后重试。');
  }

  const token = window.hcaptcha?.getResponse(widgetId)?.trim();
  if (!token) {
    throw new Error('请完成人机验证后重试。');
  }

  return token;
}
