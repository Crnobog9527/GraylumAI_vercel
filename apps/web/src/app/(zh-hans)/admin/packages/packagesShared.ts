/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Types and labels shared by the admin packages page, its two tabs and its two dialogs.

export interface CreditPackage {
  id: string;
  name: string;
  price: number;
  credits_amount: number;
  bonus_credits: number;
  stripe_price_id?: string | null;
  sort_order: number;
  is_popular: string;
  active: string;
  created_at: string;
}

export interface MembershipPlan {
  id: string;
  name: string;
  level: 'free' | 'pro' | 'gold';
  monthly_price: number;
  yearly_price: number;
  stripe_monthly_price_id?: string | null;
  stripe_yearly_price_id?: string | null;
  monthly_credits: number;
  yearly_credits: number;
  monthly_bonus_credits: number;
  package_discount: number;
  features: string[];
  max_context_messages: number;
  is_active: string;
  sort_order: number;
  created_at: string;
}

export const levelColors = {
  free: { bg: 'bg-gray-500/20', text: 'text-gray-400', label: '免费版' },
  pro: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Pro 专业版' },
  gold: { bg: 'bg-amber-500/20', text: 'text-amber-400', label: 'Gold 黄金版' },
};
