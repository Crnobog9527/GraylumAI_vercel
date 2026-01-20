'use client';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4 border-b',
  md: 'h-8 w-8 border-b-2',
  lg: 'h-12 w-12 border-b-2',
};

export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-[var(--color-primary)] ${sizeClasses[size]} ${className}`}
    />
  );
}

// 全屏加载覆盖层
interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({ message }: LoadingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="flex flex-col items-center gap-4 p-6 rounded-xl"
        style={{ background: 'var(--bg-secondary)' }}
      >
        <LoadingSpinner size="lg" />
        {message && (
          <p style={{ color: 'var(--text-secondary)' }}>{message}</p>
        )}
      </div>
    </div>
  );
}

// 内联加载状态（用于按钮等）
interface InlineLoadingProps {
  text?: string;
}

export function InlineLoading({ text = '加载中...' }: InlineLoadingProps) {
  return (
    <div className="flex items-center gap-2">
      <LoadingSpinner size="sm" />
      <span style={{ color: 'var(--text-tertiary)' }}>{text}</span>
    </div>
  );
}
