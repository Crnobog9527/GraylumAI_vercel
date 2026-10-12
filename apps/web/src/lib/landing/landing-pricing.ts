/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  formatUsd, pickPaywallPlans, type PaywallBilling, type PaywallPlan, type PaywallPlanSource,
} from '@/components/paywall/paywallPlans';
import type { LandingFeature } from './landing-flags';

/**
 * Price cards for the landing page in the paywall v25 card format (offer final 2026-10-13, section 4b):
 * big current price, struck-out original, tag, saving, renewal text under the button, who it fits.
 * Every number comes from the server. The Gold first-month price and the founder offer have no public
 * server answer yet; until one is passed in, those parts are not shown (never a hard-coded $49 or $496).
 */
export type LandingOffers = {
  goldFirstMonth?: number | null;
  founder?: { price: number; total: number; available: number } | null;
};

export type CardQuote = {
  price: string;
  per: string;
  strike: string | null;
  tag: string | null;
  saving: string | null;
  renewal: string;
};

export type LandingCardKey = 'pro' | 'gold' | 'founder';

export type LandingCard = {
  key: LandingCardKey;
  name: string;
  recommended: boolean;
  result: { text: string; needs: readonly LandingFeature[] };
  fit: string;
  cta: string;
  checkoutReady: Record<PaywallBilling, boolean>;
  quotes: Record<PaywallBilling, CardQuote | null>;
  // Shown instead of a price on a billing tab the card does not offer.
  missingNote: Partial<Record<PaywallBilling, string>>;
};

export type LandingPricing = {
  cards: LandingCard[];
  yearlyBadge: string | null;
  founderOpen: boolean;
  proMonthly: number | null;
};

const CARD_TEXT = {
  pro: {
    name: 'Pro',
    result: { text: '专心做好 1 个账号，报告和每周发什么都替你排好', needs: ['report', 'content'] },
    fit: '刚起步、先专心做好 1 个账号',
    cta: '开通 Pro',
  },
  gold: {
    name: 'Gold',
    result: { text: '多个账号一起做，每周有人替你看数据、调方向', needs: ['publish'] },
    fit: '布局多个平台、多个账号，要多角度的专业方案',
    cta: '开通 Gold',
  },
  founder: {
    name: '创始会员',
    result: { text: 'Gold 的全部，加上直接和创始人沟通', needs: ['founder'] },
    fit: '想长期做、想直接和创始人交流',
    cta: '成为创始会员',
  },
} as const;

const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Monthly equivalent rounded down to the cent so it never understates the price per month. */
function perMonth(yearly: number) {
  return formatUsd(Math.floor((yearly / 12) * 100) / 100);
}

function savingPercent(monthly: number, yearly: number) {
  const percent = Math.floor(((monthly * 12 - yearly) / (monthly * 12)) * 100);
  return percent > 0 ? percent : 0;
}

function yearlyQuote(monthly: number, yearly: number, tag: string | null, renewal: string): CardQuote {
  const saved = monthly * 12 - yearly;
  return {
    price: formatUsd(yearly), per: '/年', strike: saved > 0 ? formatUsd(monthly * 12) : null, tag,
    saving: saved > 0 ? `比按月付省 ${formatUsd(saved)} · 相当于 ${perMonth(yearly)}/月` : `相当于 ${perMonth(yearly)}/月`,
    renewal,
  };
}

function standardYearly(plan: PaywallPlan) {
  if (!usable(plan.price.yearly)) return null;
  return yearlyQuote(plan.price.monthly, plan.price.yearly, null,
    `每年自动续费 ${formatUsd(plan.price.yearly)}，可随时取消`);
}

function goldMonthly(plan: PaywallPlan, firstMonth: number | null): CardQuote {
  const monthly = formatUsd(plan.price.monthly);
  if (firstMonth !== null && firstMonth < plan.price.monthly) {
    const first = formatUsd(firstMonth);
    return { price: first, per: ' 首月', strike: monthly, tag: '新用户首月', saving: `首月 ${first}，之后每月 ${monthly}`,
      renewal: `首月 ${first}，之后每月 ${monthly} 自动续费，可随时取消` };
  }
  return { price: monthly, per: '/月', strike: null, tag: null, saving: null, renewal: `每月自动续费 ${monthly}，可随时取消` };
}

function planCard(key: 'pro' | 'gold', plan: PaywallPlan, monthly: CardQuote): LandingCard {
  const text = CARD_TEXT[key];
  return {
    key, name: text.name, recommended: key === 'gold', result: text.result, fit: text.fit, cta: text.cta,
    checkoutReady: { monthly: plan.checkoutReady?.monthly === true, yearly: plan.checkoutReady?.yearly === true },
    quotes: { monthly, yearly: standardYearly(plan) }, missingNote: {},
  };
}

/** Builds the three cards from the server catalog and, when the server provides them, the special offers. */
export function buildLandingPricing(source: readonly PaywallPlanSource[] | undefined, offers: LandingOffers = {}): LandingPricing {
  const plans = pickPaywallPlans(source);
  const pro = plans.find(plan => plan.level === 'pro');
  const gold = plans.find(plan => plan.level === 'gold');
  const cards: LandingCard[] = [];
  const savings: number[] = [];

  if (pro) {
    const price = formatUsd(pro.price.monthly);
    cards.push(planCard('pro', pro, { price, per: '/月', strike: null, tag: null, saving: null,
      renewal: `每月自动续费 ${price}，可随时取消` }));
    if (usable(pro.price.yearly)) savings.push(savingPercent(pro.price.monthly, pro.price.yearly));
  }
  if (gold) {
    const firstMonth = usable(offers.goldFirstMonth) ? offers.goldFirstMonth : null;
    cards.push(planCard('gold', gold, goldMonthly(gold, firstMonth)));
    if (usable(gold.price.yearly)) savings.push(savingPercent(gold.price.monthly, gold.price.yearly));
  }

  const founder = offers.founder;
  const founderOpen = Boolean(gold && founder && usable(founder.price) && founder.available > 0);
  if (gold && founder && founderOpen) {
    const text = CARD_TEXT.founder;
    const yearly = yearlyQuote(gold.price.monthly, founder.price, '创始会员 · 终身 6 折',
      `首年 ${formatUsd(founder.price)}，之后每年按当时 Gold 月付×12 的 6 折续费，可随时取消`);
    cards.push({
      key: 'founder', name: text.name, recommended: false, result: text.result, fit: text.fit, cta: text.cta,
      checkoutReady: { monthly: false, yearly: true },
      quotes: { monthly: null, yearly }, missingNote: { monthly: '（创始会员只有年付）' },
    });
    savings.push(savingPercent(gold.price.monthly, founder.price));
  }

  const best = Math.max(0, ...savings);
  return {
    cards,
    yearlyBadge: best > 0 ? `最高省 ${best}%` : null,
    founderOpen,
    proMonthly: pro ? pro.price.monthly : null,
  };
}

/** Prices for the SoftwareApplication JSON-LD; the same numbers the cards show. */
export function landingOfferList(pricing: LandingPricing) {
  const offers = [{ name: '免费', price: 0 }];
  for (const card of pricing.cards) {
    for (const cycle of ['monthly', 'yearly'] as const) {
      const quote = card.quotes[cycle];
      if (!quote) continue;
      const label = quote.per === '/年' ? '年付' : quote.per === '/月' ? '月付' : quote.per.trim();
      offers.push({ name: `${card.name} ${label}`, price: Number(quote.price.replace(/[$,]/g, '')) });
    }
  }
  return offers;
}
