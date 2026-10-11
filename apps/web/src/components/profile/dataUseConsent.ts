/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** D5 data-use consent (AGENT-CORE R10): the state returned by `dataUse.consent` / `dataUse.setConsent`. */
export interface DataUseConsentState {
  purpose: 'team_improvement';
  currentVersion: string;
  granted: boolean;
  version: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
}

/**
 * The version of the explanation this card shows. A grant always sends this value, so the server
 * records consent to the words the user actually read; when the server moves to a new version the
 * card stops offering a grant until its own text is updated to match.
 */
export const DATA_USE_COPY_VERSION = 'd5-v1';

export type DataUseConsentStatus = 'granted' | 'outdated' | 'revoked' | 'never';

export function consentStatus(state: DataUseConsentState): DataUseConsentStatus {
  if (state.granted) return 'granted';
  if (state.revokedAt) return 'revoked';
  if (state.version && state.version !== state.currentVersion) return 'outdated';
  return 'never';
}

/** A grant is only offered for the text this card shows; revoking is always allowed. */
export function canGrant(state: DataUseConsentState): boolean {
  return state.currentVersion === DATA_USE_COPY_VERSION;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function consentStatusText(state: DataUseConsentState): string {
  switch (consentStatus(state)) {
    case 'granted': {
      const at = formatTime(state.grantedAt);
      return at ? `已开启（${at} 同意）` : '已开启';
    }
    case 'revoked': {
      const at = formatTime(state.revokedAt);
      return at ? `已关闭（${at} 撤回）` : '已关闭';
    }
    case 'outdated':
      return '说明已更新，之前的同意已失效。如仍愿意参与，请阅读后重新开启。';
    default:
      return '未开启（默认不参与）';
  }
}

const SAVE_FAILED = '暂时没能保存，请稍后重试。';

export function consentErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('DATA_USE_VERSION_STALE')) return '说明已经更新，请刷新页面阅读新的说明后再开启。';
  if (message.includes('DATA_USE_ACCOUNT_CLOSED')) return '账号已关闭，不能开启。';
  return SAVE_FAILED;
}

type SetConsent = (input: { granted: boolean; version: string }) => Promise<DataUseConsentState>;
export type ConsentChange = { state: DataUseConsentState; error?: undefined } | { state?: undefined; error: string };

/** Grant or revoke; returns the saved state, or a readable error. Never reports a change the server did not make. */
export async function changeConsent(granted: boolean, setConsent: SetConsent): Promise<ConsentChange> {
  try {
    const state = await setConsent({ granted, version: DATA_USE_COPY_VERSION });
    if (state.granted !== granted) return { error: SAVE_FAILED };
    return { state };
  } catch (error) {
    return { error: consentErrorMessage(error) };
  }
}
