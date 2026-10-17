/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { FeatureSlug } from '@/lib/seo/content/features';
import { DemoContent } from './DemoContent';
import { DemoJury } from './DemoJury';
import { DemoLibrary } from './DemoLibrary';
import { DemoPositioning } from './DemoPositioning';

/**
 * The product screen of one feature page, chosen on the server so a page ships only its own demo (each demo is its own
 * client module). Owner 2026-10-17: the landing and feature pages use the product's real display components, never redrawn.
 */
export function FeatureDemo({ slug }: { slug: FeatureSlug }) {
  switch (slug) {
    case 'positioning': return <DemoPositioning />;
    case 'content': return <DemoContent />;
    case 'library': return <DemoLibrary />;
    case 'jury': return <DemoJury />;
    // Publishing and data review have no product screen to reuse yet: text only until the product has display components.
    case 'publish':
    case 'review': return null;
  }
}
