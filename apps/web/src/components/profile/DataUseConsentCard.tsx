/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { trpc } from '@/trpc/client';
import {
  canGrant,
  changeConsent,
  consentStatus,
  consentStatusText,
  grantedToOtherCopy,
  type DataUseConsentState,
} from './dataUseConsent';

const SWITCH_ID = 'data-use-consent-switch';

/*
 * What the switch covers, written to match what the server does today (D5, Owner decision 2):
 * a team read passes the consent filter, nothing is de-identified yet, and revoking stops new reads.
 * Changing these words means a new DATA_USE_COPY_VERSION together with the server's version.
 */
const EXPLANATION = [
  '开启后，Graylum 团队可以为了人工改进产品，查看你在 Graylum 里的使用记录，包括对话内容和生成的成果（例如定位报告、内容草稿）。',
  '目前这些记录不会用来训练模型，也不会自动修改 Skill。',
  '你可以随时关闭。关闭后，团队不再读取你的记录；注销账号也会自动关闭。',
  '开不开启都不影响你自己使用和查看自己的内容。用途有变化时，我们会重新征求你的同意。',
];

export interface DataUseConsentViewProps {
  state?: DataUseConsentState;
  loading: boolean;
  loadFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
  saving: boolean;
  error: string | null;
  onChange: (granted: boolean) => void;
}

export function DataUseConsentView({ state, loading, loadFailed, retrying, onRetry, saving, error, onChange }: DataUseConsentViewProps) {
  const granted = state ? consentStatus(state) === 'granted' : false;
  // Never shown as "off" when the state is unknown: a failed read hides the switch instead.
  const grantBlocked = state ? !granted && !canGrant(state) : true;
  // On, but to a newer text than this page carries: keep revoking, never present these words as the agreed terms.
  const staleCopy = state ? grantedToOtherCopy(state) : false;

  return (
    <div className="mt-6 rounded-2xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={SWITCH_ID} className="font-medium" style={{ color: 'var(--text-primary)' }}>
            帮助改进 Graylum（可选）
          </label>
          <div className="mt-2 space-y-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {staleCopy
              ? <p role="status">你已同意更新后的说明，这个页面显示的还是旧版本。请刷新页面查看你同意的内容；不想继续参与，可以直接在这里关闭。</p>
              : EXPLANATION.map((line) => <p key={line}>{line}</p>)}
          </div>
        </div>
        {state && (
          <div className="flex shrink-0 items-center gap-2 pt-1">
            {saving && <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--text-tertiary)' }} />}
            <Switch
              id={SWITCH_ID}
              checked={granted}
              disabled={saving || grantBlocked}
              onCheckedChange={(next) => onChange(next)}
            />
          </div>
        )}
      </div>

      <div className="mt-3 text-sm" aria-live="polite">
        {loading && <p style={{ color: 'var(--text-tertiary)' }}>正在读取…</p>}
        {!loading && loadFailed && (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span style={{ color: '#fca5a5' }}>暂时无法读取你的选择，请稍后重试。</span>
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline disabled:opacity-60"
              style={{ color: 'var(--color-primary)' }}
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {retrying ? '正在重试' : '重试'}
            </button>
          </div>
        )}
        {state && <p style={{ color: granted ? 'var(--color-primary)' : 'var(--text-secondary)' }}>{consentStatusText(state)}</p>}
        {state && grantBlocked && <p style={{ color: 'var(--text-tertiary)' }}>说明正在更新，暂时不能开启。</p>}
        {error && <p role="alert" style={{ color: '#fca5a5' }}>{error}</p>}
      </div>
    </div>
  );
}

/** Personal-center D5 switch. Reads and changes only the signed-in user's own consent. */
export function DataUseConsentCard() {
  const utils = trpc.useUtils();
  const query = trpc.dataUse.consent.useQuery(undefined, { retry: 1 });
  const mutation = trpc.dataUse.setConsent.useMutation();
  const [error, setError] = useState<string | null>(null);

  const onChange = async (granted: boolean) => {
    if (mutation.isPending) return;
    setError(null);
    const result = await changeConsent(granted, (input) => mutation.mutateAsync(input));
    if (result.state) {
      utils.dataUse.consent.setData(undefined, result.state);
      return;
    }
    setError(result.error);
    // Show what the server actually holds after a failure, not what the switch was moved to.
    void query.refetch();
  };

  return (
    <DataUseConsentView
      // A failed re-read (e.g. after a save with an unknown outcome) keeps the old cache; that cache is not the
      // server's answer, so treat the state as unknown instead of showing a switch that may be wrong.
      state={query.isError ? undefined : query.data}
      loading={query.isLoading}
      loadFailed={query.isError}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
      saving={mutation.isPending}
      error={error}
      onChange={(granted) => void onChange(granted)}
    />
  );
}
