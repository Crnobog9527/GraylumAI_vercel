// SocialCrawl (https://www.socialcrawl.dev/docs). Every response carries
// `credits_used`. Credits are sold in GBP only; the USD figure uses the most
// expensive paid pack (Starter, GBP 0.006 per credit) at a deliberately high
// 1.40 USD/GBP, so it over-states rather than under-states spend.
// Worst-case credits per call follow /docs/endpoint-pricing and platform pages.

import { bool, count, list, text, timestamp } from '../metrics.mjs';

const BASE = 'https://www.socialcrawl.dev/v1';
export const SOCIALCRAWL_USD_PER_CREDIT = 0.006 * 1.4;

function spec(pathname, params, worstCredits) {
  const url = new URL(`${BASE}${pathname}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return { method: 'GET', url: url.toString(), worstCaseUsd: worstCredits * SOCIALCRAWL_USD_PER_CREDIT };
}

// Metered endpoints charge per row returned; `limit` bounds the hold.
const PLAN = {
  Q02: () => spec('/douyin/search', { query: '露营装备', limit: '3' }, 15),
  Q03: () => spec('/xiaohongshu/search', { query: '极简护肤', limit: '3' }, 15),
  Q06: () => spec('/tiktok/profile', { handle: 'natgeo' }, 1),
  // limit=30 holds ceil(30/4)+2 = 10 credits; the documented range tops out at 42.
  Q07: () => spec('/tiktok/search', { query: 'camping gear', limit: '30' }, 42),
  // 1 credit per page without include=channel; reserve 5 because the page says "metered".
  Q08: () => spec('/youtube/channel/videos', { handle: 'NASA', sort: 'latest' }, 5),
  Q09: () => spec('/twitter/profile', { handle: 'NASA' }, 1),
  // 1 credit per page unless include=audio; documented range tops out at 17.
  Q10: () => spec('/instagram/profile/posts', { handle: 'natgeo' }, 17),
};
const UNSUPPORTED = {
  Q01: 'general web search is outside the social-data scope tested; price of the Google source not verified',
  Q04: 'Bilibili is not in the SocialCrawl platform catalogue',
  Q05: 'Weibo is not in the SocialCrawl platform catalogue',
};

function post(raw) {
  const item = raw?.post ?? raw;
  return {
    id: text(item, ['id']),
    url: text(item, ['url']),
    title: text(item, ['content.text', 'title']),
    author: text(item, ['author.username', 'author.display_name']),
    publishedAt: timestamp(item, ['published_at', 'ext.published_at_epoch']),
    views: count(item, ['engagement.views']),
    likes: count(item, ['engagement.likes']),
    comments: count(item, ['engagement.comments']),
    shares: count(item, ['engagement.shares']),
  };
}

function profile(data) {
  const author = data?.author ?? data;
  return {
    id: text(author, ['id']),
    name: text(author, ['display_name']),
    handle: text(author, ['username']),
    followers: count(author, ['followers']),
    following: count(author, ['following']),
    postsCount: count(author, ['posts_count']),
    likesTotal: count(author, ['likes_count']),
    bio: text(author, ['bio']),
    verified: bool(author, ['verified']),
  };
}

export const socialcrawl = {
  id: 'socialcrawl',
  label: 'SocialCrawl',
  keyEnv: 'SOCIALCRAWL_API_KEY',
  maxCalls: 8,
  maxUsd: 1,
  timeoutMs: 90_000,
  steps(query) {
    if (PLAN[query.id]) return [PLAN[query.id]()];
    return { notSupported: UNSUPPORTED[query.id] ?? 'not planned' };
  },
  authorize(requestSpec, key) {
    return { url: requestSpec.url, init: { method: requestSpec.method, headers: { 'x-api-key': key, Accept: 'application/json' } } };
  },
  isFailure: json => json?.success !== true,
  failureReason: json => text(json, ['error.type', 'error.status']) ?? 'VENDOR_ERROR',
  reportedCostUsd(json) {
    const credits = count(json, ['credits_used']);
    return credits === undefined ? null : Math.round(credits * SOCIALCRAWL_USD_PER_CREDIT * 1e6) / 1e6;
  },
  reportedRaw(json) {
    const credits = count(json, ['credits_used']);
    return credits === undefined ? null : `${credits} credits`;
  },
  kind: query => query.type,
  normalize(json, query) {
    if (query.type === 'profile') return [profile(json.data)];
    return list(json, ['data.items', 'data.posts', 'data']).map(post);
  },
};
