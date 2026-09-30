export const HCAPTCHA_SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js';

export type HCaptchaRenderOptions = {
  sitekey: string;
  size?: 'normal' | 'compact' | 'invisible';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
};

export type HCaptchaClient = {
  getResponse: (widgetId?: number) => string;
  reset: (widgetId?: number) => void;
  render?: (container: HTMLElement, options: HCaptchaRenderOptions) => number;
  remove?: (widgetId: number) => void;
  execute?: (widgetId: number, options: { async: true }) => Promise<{ response: string; key?: string }>;
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
