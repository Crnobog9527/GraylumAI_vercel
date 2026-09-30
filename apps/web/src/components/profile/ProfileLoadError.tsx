import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ProfileLoadErrorProps {
  hasError: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}

// 个人资料没有读到时显示明确的失败状态，不用默认会员等级或用户名冒充真实数据。
export function ProfileLoadError({ hasError, isRetrying, onRetry }: ProfileLoadErrorProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-4 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" style={{ color: 'var(--color-primary)' }} />
        <div>
          <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
            {hasError ? '个人资料读取失败' : '暂时没有读到个人资料'}
          </div>
          <div className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            暂时无法确认你的会员等级和账户信息，请稍后重试。
          </div>
        </div>
      </div>
      <Button variant="outline" className="gap-2" disabled={isRetrying} onClick={onRetry}>
        {isRetrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {isRetrying ? '正在重试' : '重试'}
      </Button>
    </div>
  );
}
