'use client';

interface AdminLoadingStateProps {
  message?: string;
}

export default function AdminLoadingState({ message }: AdminLoadingStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
      {message && (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
