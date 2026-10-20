import type { Metadata } from 'next';
import { SearchX } from 'lucide-react';
import { StatusScreen } from '@/components/layout/StatusScreen';

export const metadata: Metadata = {
  title: '页面不存在',
};

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      title="页面不存在"
      description="你访问的页面不存在，或链接已经失效。"
      icon={<SearchX className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
    />
  );
}
