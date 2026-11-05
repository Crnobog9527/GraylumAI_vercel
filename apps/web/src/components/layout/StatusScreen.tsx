import type { ReactNode } from 'react';
import { Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS, AuthCard, AuthHead, AuthShell } from '@/components/auth/AuthShell';

interface StatusScreenProps {
  code: string;
  title: string;
  description: string;
  icon: ReactNode;
  onRetry?: () => void;
  reference?: string;
  /** Button and reference wording; Simplified by default, Traditional on /zh-tw pages. */
  labels?: StatusScreenLabels;
}

export type StatusScreenLabels = { retry: string; home: string; homeHref: string; reference: string };

const SIMPLIFIED_LABELS: StatusScreenLabels = { retry: '重试', home: '返回首页', homeHref: '/', reference: '错误编号' };
export const TAIWAN_LABELS: StatusScreenLabels = { retry: '重試', home: '返回首頁', homeHref: '/zh-tw', reference: '錯誤編號' };

// 全站错误页和 404 页共用的展示（外观：AuthShell，公开页层）。首页链接用普通 <a>，出错后整页重新加载更稳妥。
export function StatusScreen({
  code, title, description, icon, onRetry, reference, labels = SIMPLIFIED_LABELS,
}: StatusScreenProps) {
  return (
    <AuthShell homeHref={labels.homeHref}>
      <AuthCard>
        <div role={onRetry ? 'alert' : undefined} className="space-y-6">
          <AuthHead icon={icon} title={title} lead={<><span className="block text-sm font-medium text-[var(--pub-ink)]">{code}</span>{description}</>} />
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            {onRetry && (
              <Button type="button" onClick={onRetry} className={`${AUTH_PRIMARY_BUTTON_CLASS} sm:w-auto`}>
                <RefreshCw />
                {labels.retry}
              </Button>
            )}
            <Button
              asChild
              variant={onRetry ? 'outline' : 'default'}
              className={onRetry ? AUTH_SECONDARY_BUTTON_CLASS : `${AUTH_PRIMARY_BUTTON_CLASS} sm:w-auto`}
            >
              <a href={labels.homeHref}>
                <Home />
                {labels.home}
              </a>
            </Button>
          </div>
          {reference && (
            <p className="text-center text-xs text-[var(--pub-muted)]">
              {labels.reference}：{reference}
            </p>
          )}
        </div>
      </AuthCard>
    </AuthShell>
  );
}
