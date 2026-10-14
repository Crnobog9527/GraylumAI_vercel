/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MethodCheckoutForm } from './MethodCheckoutForm';
import type { MethodPurchase } from './methodCheckout';
import type { MethodCheckout } from './useMethodCheckout';

export type MethodCheckoutTarget = {
  title: string;
  description: string;
  purchase: MethodPurchase;
  price: string;
  renewal: string;
  cta: string;
  details?: readonly string[];
  fineprint?: string | null;
};

/** Confirm-and-pay dialog for the membership page and credit packs. */
export function MethodCheckoutDialog({ target, checkout, onClose, onGoldFirstDeclined, onFounderSoldOut, notice }: {
  target: MethodCheckoutTarget | null;
  checkout: MethodCheckout;
  onClose: () => void;
  onGoldFirstDeclined?: () => void;
  onFounderSoldOut?: () => void;
  notice?: string | null;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !checkout.pending) onClose(); }}>
      <DialogContent data-testid="method-checkout-dialog" className="max-h-[90vh] max-w-md overflow-y-auto"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>{target?.title}</DialogTitle>
          <DialogDescription style={{ color: 'var(--text-tertiary)' }}>{target?.description}</DialogDescription>
        </DialogHeader>
        {target?.details?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {target.details.map(item => <li key={item}>{item}</li>)}
          </ul>
        ) : null}
        {target ? (
          <MethodCheckoutForm checkout={checkout} purchase={target.purchase} price={target.price} renewal={target.renewal}
            cta={target.cta} testIdPrefix="method-checkout" onGoldFirstDeclined={onGoldFirstDeclined}
            onFounderSoldOut={onFounderSoldOut} notice={notice} fineprint={target.fineprint} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
