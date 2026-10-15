/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';

export type LandingData = ReturnType<typeof buildLandingPageData>;

/** The position of an element in its section's entrance (IReveal reads it as `--d`). */
export const order = (d: number) => ({ '--d': d }) as CSSProperties;
