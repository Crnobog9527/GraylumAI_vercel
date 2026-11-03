/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-2: simulated back-office rate diagnostics (tech plan v2 section 2) for the dataset accounts. Fixed values,
 * no randomness: Douyin has two fresh posts stuck at the hook and one that passes, plus ten older posts as the user's own
 * history; TikTok has one fresh post without a 2-second bounce rate (the platform does not show it). Invented numbers.
 */
import type { SimPost } from './simulatedDataset.ts';

export type SimDiagnostic = { postKey: string; platform: string; source: 'manual'; rates: Record<string, number>;
  openingText: string | null; videoSeconds: number | null; dropSecond: number | null; capturedOn: string };

const DOUYIN_FRESH = [
  { rates: { bounce_2s: 0.62, retain_3s: 0.31, retain_5s: 0.22, complete_rate: 0.08, avg_watch_seconds: 9, like_rate: 0.03,
    comment_rate: 0.004, save_rate: 0.006, share_rate: 0.002 }, video: 35, drop: 2,
  opening: '大家好，我是小林，今天跟大家聊聊做小红书的一些心得。' },
  { rates: { bounce_2s: 0.58, retain_3s: 0.36, retain_5s: 0.25, complete_rate: 0.1, avg_watch_seconds: 11, like_rate: 0.035,
    comment_rate: 0.005, save_rate: 0.008, share_rate: 0.003 }, video: 40, drop: 3,
  opening: '最近很多人问我，新手到底应该怎么开始？我们先来看一个问题。' },
  { rates: { bounce_2s: 0.38, retain_3s: 0.55, retain_5s: 0.42, complete_rate: 0.21, avg_watch_seconds: 19, like_rate: 0.05,
    comment_rate: 0.008, save_rate: 0.015, share_rate: 0.006 }, video: 38, drop: null,
  opening: '3 个动作，让你的封面点击率翻倍，第一个最多人做错。' },
];

/** Diagnostics for one account's posts; `day(n)` is the date n days before asOf. */
export function simulatedDiagnostics(key: string, posts: SimPost[], day: (daysAgo: number) => string): SimDiagnostic[] {
  const daily = (platform: string) => posts.filter(p => p.platform === platform && p.visibility === 'daily'
    && !p.title.startsWith('忽略之前')).toSorted((a, b) => a.postedDaysAgo - b.postedDaysAgo);
  const out: SimDiagnostic[] = [];
  if (key === 'A') {
    const douyin = daily('douyin').filter(p => p.postedDaysAgo >= 3);
    DOUYIN_FRESH.forEach((d, i) => {
      const post = douyin[i]!;
      out.push({ postKey: post.key, platform: 'douyin', source: 'manual', rates: d.rates, openingText: d.opening,
        videoSeconds: d.video, dropSecond: d.drop, capturedOn: day(1) });
    });
    douyin.filter(p => p.postedDaysAgo >= 20).slice(0, 10).forEach((post, i) => {
      const bounce = 0.45 + (i % 4) * 0.04;
      out.push({ postKey: post.key, platform: 'douyin', source: 'manual', openingText: null, videoSeconds: 30 + i, dropSecond: null,
        rates: { bounce_2s: bounce, retain_3s: 0.95 - bounce - 0.05, retain_5s: 0.3 + (i % 3) * 0.03, complete_rate: 0.12 + (i % 5) * 0.01,
          like_rate: 0.035 + (i % 3) * 0.004 }, capturedOn: day(post.postedDaysAgo - 3) });
    });
  }
  if (key === 'C') {
    const post = daily('tiktok').filter(p => p.postedDaysAgo >= 3)[0]!;
    out.push({ postKey: post.key, platform: 'tiktok', source: 'manual', videoSeconds: 28, dropSecond: 4, capturedOn: day(1),
      openingText: '这家店我去了三次，第三次才发现隐藏菜单。', rates: { avg_watch_seconds: 6, complete_rate: 0.11, like_rate: 0.04,
        comment_rate: 0.003, share_rate: 0.002, follow_rate: 0.001 } });
  }
  return out;
}
