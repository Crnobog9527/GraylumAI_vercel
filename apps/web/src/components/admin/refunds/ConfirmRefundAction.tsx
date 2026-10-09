/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Props = {
  label: string;
  pendingLabel: string;
  title: string;
  confirmLabel: string;
  children: ReactNode;
  pending: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testId: string;
  onConfirm: () => void;
};

/** A button that always asks for confirmation first and stays disabled while its request runs. */
export function ConfirmRefundAction(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid={props.testId} variant={props.destructive ? 'destructive' : 'default'}
        disabled={props.disabled || props.pending} onClick={() => setOpen(true)}>
        {props.pending ? props.pendingLabel : props.label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: 'var(--text-primary)' }}>{props.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{props.children}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction data-testid={`${props.testId}-confirm`} disabled={props.pending}
              onClick={() => { setOpen(false); props.onConfirm(); }}>
              {props.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
