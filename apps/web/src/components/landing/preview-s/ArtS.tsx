/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef } from 'react';
import { PosterS4 } from './PosterS4';
import { PrismS1 } from './PrismS1';
import base from './s-base.module.css';
import { ScrapS3 } from './ScrapS3';
import { SkyS2 } from './SkyS2';
import { useZoneWeights } from './use-zone-weights';

export type Variant = 's1' | 's2' | 's3' | 's4';
const SCENES = { s1: PrismS1, s2: SkyS2, s3: ScrapS3, s4: PosterS4 } as const;

/**
 * A sample S page's backdrop: one layer under the whole page (behind main, the header and the footer), holding the
 * sample's own scene. It writes where the reader is (`--s-t`, `--w0`…`--w3`, use-zone-weights) on the page root, so
 * each scene follows the scroll in CSS alone.
 */
export function ArtS({ variant }: { variant: Variant }) {
  const ref = useRef<HTMLDivElement>(null);
  useZoneWeights(ref);
  const Scene = SCENES[variant];
  return <div ref={ref} aria-hidden="true" className={base.art}><Scene /></div>;
}
