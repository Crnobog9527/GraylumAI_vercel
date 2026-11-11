/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import localFont from 'next/font/local';

// The heading face for samples D, G and H only (see display-glyphs.ts): one small subset file.
// It sits in public/ next to its Apache 2.0 license, which is served at /fonts/noto-sans-cjk-display/LICENSE.txt.
// Not preloaded: the build put the preload in the HTML of every page of the site (login, the app, admin, every public page: 50 KB at
// high priority, measured 2026-11-11), not only the sample routes. The samples fetch it when their headings ask for it (display: swap).
export const displayFont = localFont({
  src: '../../../../public/fonts/noto-sans-cjk-display/display-subset.woff2',
  weight: '900',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--d-display',
  adjustFontFallback: false,
  fallback: ['MiSans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
});
