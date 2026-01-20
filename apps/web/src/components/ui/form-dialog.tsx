'use client';

import { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './dialog';
import { Button } from './button';

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  isSubmitting?: boolean;
  submitDisabled?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
};

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  onCancel,
  submitLabel = '保存',
  cancelLabel = '取消',
  isSubmitting = false,
  submitDisabled = false,
  size = 'md',
}: FormDialogProps) {
  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={sizeClasses[size]}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>{title}</DialogTitle>
          {description && (
            <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4 py-4">{children}</div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isSubmitting}
            style={{
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)',
            }}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={isSubmitting || submitDisabled}
            style={{
              background: 'var(--color-primary)',
              color: 'var(--bg-primary)',
            }}
          >
            {isSubmitting ? '保存中...' : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 确认对话框
interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  isConfirming?: boolean;
  variant?: 'default' | 'danger';
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  onCancel,
  confirmLabel = '确认',
  cancelLabel = '取消',
  isConfirming = false,
  variant = 'default',
}: ConfirmDialogProps) {
  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>{title}</DialogTitle>
          <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
            {description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 mt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isConfirming}
            style={{
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)',
            }}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={isConfirming}
            style={
              variant === 'danger'
                ? { background: 'var(--error)', color: 'white' }
                : { background: 'var(--color-primary)', color: 'var(--bg-primary)' }
            }
          >
            {isConfirming ? '处理中...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
