'use client';

const UNSAFE_ERROR_PATTERNS = [
  /\bunknown error\b/i,
  /\bpermission denied\b/i,
  /\badmin role required\b/i,
  /\bforbidden\b/i,
  /\brelation\b/i,
  /\bsyntax error\b/i,
  /\bdatabase\b/i,
  /\bpostgres\b/i,
  /\bpgrst\b/i,
  /\bsupabase\b/i,
  /\bstripe\b/i,
  /\bservice[_ -]?role\b/i,
  /\bsecret[_ -]?key\b/i,
  /\bprice id\b/i,
  /\btoken\b/i,
  /\bfetch failed\b/i,
  /\bnetwork error\b/i,
  /\btimeout\b/i,
  /\bhttp\s*\d{3}\b/i,
];

export function getErrorMessageText(error: unknown) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return '';
}

// Auth errors worth a specific Chinese message. A closed and a disabled account read the same,
// so the message never reveals which one it is.
export const ACCOUNT_UNAVAILABLE_MESSAGE = '该账号已注销或已被停用，无法登录';

function translateKnownAuthError(error: unknown, message: string): string | null {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'user_banned' || /\buser is banned\b/i.test(message)) {
    return ACCOUNT_UNAVAILABLE_MESSAGE;
  }
  return null;
}

// tRPC serializes zod input failures as a JSON array of issues in `message`. Show the
// server-written issue messages instead of the raw array; anything else is not an issue list.
export function readValidationIssueMessages(message: string): string | null {
  if (!message.startsWith('[')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const texts = parsed.map((issue) => (issue && typeof issue === 'object' && 'message' in issue
      && typeof issue.message === 'string' ? issue.message.trim() : ''));
    if (texts.some((text) => !text)) {
      return null;
    }
    return [...new Set(texts)].join('；');
  } catch {
    return null;
  }
}

export function getSafeErrorMessage(error: unknown, fallback: string) {
  const rawMessage = getErrorMessageText(error).trim();
  const message = readValidationIssueMessages(rawMessage) ?? rawMessage;
  const translated = translateKnownAuthError(error, message);
  if (translated) {
    return translated;
  }

  if (!message) {
    return fallback;
  }

  if (message.length > 180) {
    return fallback;
  }

  if (UNSAFE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return fallback;
  }

  return message;
}

export function isAdminPermissionError(error: unknown) {
  const message = getErrorMessageText(error).toLowerCase();

  return (
    message.includes('admin role required') ||
    message.includes('you do not have permission') ||
    message.includes('access denied') ||
    message.includes('permission')
  );
}
