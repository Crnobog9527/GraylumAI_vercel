import type { ReactNode } from 'react';
import { Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StatusScreenProps {
  code: string;
  title: string;
  description: string;
  icon: ReactNode;
  onRetry?: () => void;
  reference?: string;
}

// 全站错误页和 404 页共用的展示。首页链接用普通 <a>，出错后整页重新加载更稳妥。
export function StatusScreen({ code, title, description, icon, onRetry, reference }: StatusScreenProps) {
  return (
    <main
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--bg-primary)' }}
    >
      <section
        role={onRetry ? 'alert' : undefined}
        className="w-full max-w-lg rounded-2xl px-8 pt-12 pb-10 text-center"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <div
          className="w-16 h-16 mx-auto mb-6 rounded-2xl flex items-center justify-center"
          style={{ background: 'var(--color-primary-10)', border: '1px solid var(--color-primary-20)' }}
        >
          {icon}
        </div>
        <p className="text-sm font-medium mb-2" style={{ color: 'var(--color-primary)' }}>{code}</p>
        <h1 className="text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>{title}</h1>
        <p className="text-base mb-8" style={{ color: 'var(--text-secondary)' }}>{description}</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {onRetry && (
            <Button type="button" onClick={onRetry}>
              <RefreshCw />
              重试
            </Button>
          )}
          <Button asChild variant={onRetry ? 'outline' : 'default'}>
            <a href="/">
              <Home />
              返回首页
            </a>
          </Button>
        </div>
        {reference && (
          <p className="text-xs mt-6" style={{ color: 'var(--text-tertiary)' }}>
            错误编号：{reference}
          </p>
        )}
      </section>
    </main>
  );
}
