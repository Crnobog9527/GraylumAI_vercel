/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AdminPaymentDisputes } from '@/components/admin/refunds/AdminPaymentDisputes';
import { AdminMonthlyRefunds } from '@/components/admin/refunds/AdminMonthlyRefunds';
import { AdminPackageRefunds } from '@/components/admin/refunds/AdminPackageRefunds';
import { AdminPackRefundReviews } from '@/components/admin/refunds/AdminPackRefundReviews';

export default function AdminRefundsPage() {
  return (
    <>
      <AdminPaymentDisputes />
      <AdminMonthlyRefunds />
      <AdminMonthlyRefunds variant="subscription" />
      <AdminPackageRefunds />
      <AdminPackRefundReviews />
    </>
  );
}
