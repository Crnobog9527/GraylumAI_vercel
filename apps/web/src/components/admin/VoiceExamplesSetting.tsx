/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Feather, Loader2 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSafeErrorMessage } from '@/lib/safe-error-message';

export const VOICE_EXAMPLES_SETTING_KEY = 'voice_examples';
const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };

/**
 * VOICE-2 PR-4: the administrator's switch for 文风 2.0 (system_settings voice_examples). On (the default, also when never saved):
 * writing uses the stats and the user's past pieces as examples. Off: back to voice-v3 at once, without either.
 * `onSaved` re-reads the settings dashboard and resolves false when that read failed.
 */
export function VoiceExamplesSetting({ saved, onSaved }: { saved: unknown; onSaved: () => Promise<boolean> }) {
  const on = saved !== false;
  const [unread, setUnread] = useState(false);
  const update = trpc.settings.updateSystemSettings.useMutation({ onSuccess: async () => { setUnread(!(await onSaved())); } });
  const locked = update.isPending || unread;
  return (
    <Card data-testid="admin-settings-voice-examples" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Feather className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          文风 2.0（写作数据和旧稿范例）
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          打开时，写稿会带上代码统计的写作数据，并参考用户 2–3 篇同类型、不同话题的旧稿，写完检查有没有照抄、只改太像的句子。
          关闭后立即退回上一版文风写法（只用文风画像），不带写作数据也不带旧稿。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span style={{ color: 'var(--text-secondary)' }}>当前：{on ? '已打开' : '已关闭'}</span>
          <Button data-testid="admin-setting-voice-examples-toggle" size="sm" variant="outline" disabled={locked}
            onClick={() => update.mutate({ key: VOICE_EXAMPLES_SETTING_KEY, value: !on })}>
            {update.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {on ? '关闭' : '打开'}
          </Button>
        </div>
        <div className="text-xs" aria-live="polite">
          {unread ? <p role="alert" style={{ color: 'var(--error)' }}>已提交保存，但重新读取失败，请刷新页面确认当前状态。</p>
            : update.error ? <p role="alert" style={{ color: 'var(--error)' }}>{getSafeErrorMessage(update.error, '保存失败，请稍后重试')}</p>
            : null}
        </div>
      </CardContent>
    </Card>
  );
}
