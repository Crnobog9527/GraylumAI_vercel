'use client';

import { Wand2, Construction } from 'lucide-react';
import { Card, CardContent } from "@/components/ui/card";
import AdminSidebar from '@/components/admin/AdminSidebar';

export default function AdminPromptsPage() {
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            提示词模块
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理系统提示词模板
          </p>
        </div>

        {/* Coming Soon Card */}
        <Card
          className="max-w-md"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center py-8">
              <div
                className="p-4 rounded-2xl mb-4"
                style={{ background: 'var(--color-primary-20)' }}
              >
                <Construction className="h-12 w-12 text-[var(--color-primary)]" />
              </div>
              <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                功能开发中
              </h2>
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                提示词模板管理功能即将上线，敬请期待。
              </p>
              <div className="flex items-center gap-2 mt-4 text-xs" style={{ color: 'var(--text-disabled)' }}>
                <Wand2 className="h-4 w-4" />
                <span>Prompts Management</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
