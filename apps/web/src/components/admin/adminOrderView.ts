/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

export const ADMIN_ORDERS_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function getItemTypeLabel(itemType: string | null | undefined) {
  if (itemType === 'credit_package') return '积分包';
  if (itemType === 'membership_plan') return '会员订阅';
  return '未知商品';
}

export function getBillingCycleLabel(cycle: string | null | undefined) {
  if (cycle === 'one_time') return '一次性';
  if (cycle === 'monthly') return '月付';
  if (cycle === 'yearly') return '年付';
  return '—';
}

export function getPaymentStatusLabel(status: string | null | undefined) {
  if (status === 'paid') return '已付款';
  if (status === 'unpaid') return '未付款';
  if (status === 'no_payment_required') return '无需付款';
  return status ? status : '未知';
}

export function getPaymentModeLabel(mode: string | null | undefined) {
  if (mode === 'test') return '测试';
  if (mode === 'live') return '正式';
  return '未知模式';
}

/** Query input for one page; the server rejects limits above 50, so the client never asks for more. */
export function adminOrdersPageInput(page: number, pageSize = ADMIN_ORDERS_PAGE_SIZE) {
  const limit = Math.min(Math.max(1, Math.floor(pageSize)), MAX_PAGE_SIZE);
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
  return { offset: safePage * limit, limit };
}

export function adminOrdersPageCount(total: number, pageSize = ADMIN_ORDERS_PAGE_SIZE) {
  return total > 0 ? Math.ceil(total / pageSize) : 1;
}
