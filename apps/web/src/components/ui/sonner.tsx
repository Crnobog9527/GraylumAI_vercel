'use client';

import { Toaster as Sonner, toast } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-[var(--bg-secondary)] group-[.toaster]:text-[var(--text-primary)] group-[.toaster]:border-[var(--border-primary)] group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-[var(--text-tertiary)]',
          actionButton:
            'group-[.toast]:bg-[var(--color-primary)] group-[.toast]:text-[var(--bg-primary)]',
          cancelButton:
            'group-[.toast]:bg-[var(--bg-tertiary)] group-[.toast]:text-[var(--text-secondary)]',
          success: 'group-[.toaster]:border-emerald-500/50',
          error: 'group-[.toaster]:border-rose-500/50',
          warning: 'group-[.toaster]:border-amber-500/50',
          info: 'group-[.toaster]:border-blue-500/50',
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
