/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import localFont from 'next/font/local';

// The heading face for sample D only (see display-glyphs.ts): one small subset file, preloaded on this route.
export const displayFont = localFont({
  src: './fonts/display-subset.woff2',
  weight: '900',
  style: 'normal',
  display: 'swap',
  variable: '--d-display',
  adjustFontFallback: false,
  fallback: ['MiSans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
});
