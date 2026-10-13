// The email a visitor typed on /login, carried to /verify-email (and back) without putting it in
// the URL, where it would reach browser history, server and Vercel logs, Referer headers and
// analytics. sessionStorage stays in this tab and is gone when the tab closes; entries also expire.
// Pages with a session read the email from the session instead; on another device or after expiry
// the verify page asks the visitor to type it.
const STORAGE_KEY = 'graylum:pending-auth-email';
export const PENDING_EMAIL_TTL_MS = 30 * 60 * 1000;

type EmailStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): EmailStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberPendingEmail(email: string, store = defaultStore(), now = Date.now()) {
  const value = email.trim();
  try {
    if (!value) store?.removeItem(STORAGE_KEY);
    else store?.setItem(STORAGE_KEY, JSON.stringify({ email: value, savedAt: now }));
  } catch {
    // Storage full or blocked: the verify page falls back to the session or a typed email.
  }
}

export function readPendingEmail(store = defaultStore(), now = Date.now()): string {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'email' in parsed && 'savedAt' in parsed) {
      const { email, savedAt } = parsed;
      const age = typeof savedAt === 'number' ? now - savedAt : -1;
      if (typeof email === 'string' && age >= 0 && age < PENDING_EMAIL_TTL_MS) return email;
    }
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Unreadable entry or blocked storage: behave as if nothing was saved.
  }
  return '';
}

export function clearPendingEmail(store = defaultStore()) {
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

// Links made before this change put ?email= in the URL. Returns that email (saved for this tab)
// and the query without it, or null when there is none, so the page can rewrite the address bar.
export function takeLegacyEmailParam(search: string, store = defaultStore()): { email: string; search: string } | null {
  const params = new URLSearchParams(search);
  if (!params.has('email')) return null;
  const email = params.get('email')?.trim() ?? '';
  params.delete('email');
  if (email) rememberPendingEmail(email, store);
  const rest = params.toString();
  return { email, search: rest ? `?${rest}` : '' };
}

type AddressBar = { location: Pick<Location, 'pathname' | 'search' | 'hash'>; history: Pick<History, 'replaceState'> };

// For /login and /verify-email on load: moves an old ?email= out of the address bar (keeping the
// rest of the query and any fragment) and returns the email this tab knows, or ''.
export function restorePendingEmail(win: AddressBar, store = defaultStore()): string {
  const legacy = takeLegacyEmailParam(win.location.search, store);
  if (legacy) win.history.replaceState(null, '', win.location.pathname + legacy.search + win.location.hash);
  return legacy?.email || readPendingEmail(store);
}
