/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Names still being saved, kept per browser tab so a reload keeps showing the new name and sends it
 * again (UI-FINISH). One key per conversation; entries expire after ten minutes. An empty name means
 * "restore the default title".
 */
const PREFIX = 'graylum-pending-conversation-name:';
const MAX_AGE_MS = 10 * 60 * 1000;

export function rememberName(store: Storage | null, sessionId: string, name: string, now = Date.now()) {
  try { store?.setItem(PREFIX + sessionId, JSON.stringify({ name, at: now })); } catch { /* The server state is authoritative. */ }
}

export function forgetName(store: Storage | null, sessionId: string) {
  try { store?.removeItem(PREFIX + sessionId); } catch { /* Nothing to forget without storage. */ }
}

export function readNames(store: Storage | null, now = Date.now()): Map<string, string> {
  const names = new Map<string, string>();
  if (!store) return names;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const id = key.slice(PREFIX.length);
      let entry: { name?: unknown; at?: unknown } | null = null;
      try { entry = JSON.parse(store.getItem(key) ?? 'null'); } catch { entry = null; }
      if (entry && typeof entry.name === 'string' && typeof entry.at === 'number' && now - entry.at < MAX_AGE_MS
        && /^[0-9a-f-]{36}$/.test(id)) names.set(id, entry.name);
      else store.removeItem(key);
    }
  } catch {
    return names;
  }
  return names;
}
