/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { formatUsd, pickPaywallPlans, type PaywallPlanSource } from '@/components/paywall/paywallPlans';
import type { ArticleContent } from '../article';
import type { FeatureSlug } from './features';
import { SIGNUP_GRANT_CREDITS } from './shared';

// "Free to start, N credits on sign-up, Pro from $X" in the opening of each feature page (SEO_GEO_SPEC 3.2: who it is for,
// what it costs, how it differs). The prices are never typed into the page text: they are read from the same plan catalog
// the pricing page uses, at build and hourly refresh, and the pricing page stays the authority. When the catalog cannot be
// read the sentence sends the reader to the pricing page instead of guessing.
const GOLD_ONLY: readonly (FeatureSlug | 'hub')[] = ['jury'];

export function pricingSentence(slug: FeatureSlug | 'hub', plans: readonly PaywallPlanSource[] = []): string {
  const free = `免费开始，注册送 ${SIGNUP_GRANT_CREDITS} 积分`;
  const [pro, gold] = ['pro', 'gold'].map(level => pickPaywallPlans(plans).find(plan => plan.level === level));
  const price = (plan?: { price: { monthly: number } }) => (plan ? formatUsd(plan.price.monthly) : null);
  if (GOLD_ONLY.includes(slug)) {
    return price(gold) ? `${free}；评审团是 Gold 会员功能，每月 ${price(gold)}。` : `${free}；评审团是 Gold 会员功能，价格见价格页。`;
  }
  if (price(pro) && price(gold)) return `${free}；会员 Pro 每月 ${price(pro)} 起，Gold 每月 ${price(gold)}。`;
  if (price(pro)) return `${free}；会员 Pro 每月 ${price(pro)} 起。`;
  return `${free}；会员价格见价格页。`;
}

/** The page content with the pricing sentence added to its definition. */
export function withPricing(content: ArticleContent, slug: FeatureSlug | 'hub', plans: readonly PaywallPlanSource[] = []): ArticleContent {
  if (!content.definition) return content;
  return { ...content, definition: { ...content.definition, text: `${content.definition.text}${pricingSentence(slug, plans)}` } };
}
