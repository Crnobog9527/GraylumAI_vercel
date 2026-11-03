/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Normalized back-office rate keys (tech plan v2 section 2.2). Fractions are 0..1; *_seconds are seconds. */
export const RATE_KEYS = ['impressions_ctr', 'bounce_2s', 'retain_3s', 'retain_5s', 'retain_30s', 'avg_watch_seconds',
  'avg_watch_pct', 'complete_rate', 'like_rate', 'comment_rate', 'save_rate', 'share_rate', 'follow_rate',
  'profile_visit_rate'] as const;
