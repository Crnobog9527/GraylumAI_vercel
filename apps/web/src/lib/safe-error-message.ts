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

export function getSafeErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessageText(error).trim();

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
