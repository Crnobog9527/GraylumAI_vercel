import type { Metadata } from 'next';
import { SearchX } from 'lucide-react';
import { StatusScreen } from '@/components/layout/StatusScreen';

export const metadata: Metadata = {
  title: '頁面不存在',
};

// A missing page under /zh-tw keeps this section's root layout (and its html lang).
export default function TaiwanNotFound() {
  return (
    <StatusScreen
      code="404"
      title="頁面不存在"
      description="你造訪的頁面不存在，或連結已經失效。"
      icon={<SearchX className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
    />
  );
}
