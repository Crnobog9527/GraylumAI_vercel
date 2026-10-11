/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { Button } from '@/components/ui/button';

/**
 * Shown when a background re-read fails but earlier data is still on screen. Retrying only
 * re-reads; it never clears what the administrator is editing.
 */
export function StaleDataNotice({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
    <span>最新数据暂时读取失败，下面显示的是上一次读取的内容。</span>
    <Button variant="outline" size="sm" onClick={onRetry}>重试读取</Button>
  </div>;
}
