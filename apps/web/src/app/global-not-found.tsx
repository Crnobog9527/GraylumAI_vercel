import type { Metadata } from 'next';
import { SearchX } from 'lucide-react';
import { StatusScreen } from '@/components/layout/StatusScreen';
import './globals.css';

// With one root layout per language there is no single layout for an address that matches no route, so Next.js
// renders this page on its own (next.config experimental.globalNotFound); it brings its own document and styles.
export const metadata: Metadata = {
  title: '页面不存在',
};

export default function GlobalNotFound() {
  return (
    <html lang="zh-Hans">
      <body className="antialiased">
        <StatusScreen
          code="404"
          title="页面不存在"
          description="你访问的页面不存在，或链接已经失效。"
          icon={<SearchX className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
        />
      </body>
    </html>
  );
}
