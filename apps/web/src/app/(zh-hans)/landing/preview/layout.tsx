/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RegionLabels } from '@/components/landing/preview-regions/RegionLabels';

// The style samples only (/landing/preview/*): every module carries a region number for the Owner to point at
// (2026-10-16). /landing itself never renders this layout.
export default function LandingPreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <RegionLabels />
    </>
  );
}
