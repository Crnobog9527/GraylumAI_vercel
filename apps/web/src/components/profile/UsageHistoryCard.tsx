'use client';

import { memo } from 'react';
import Link from 'next/link';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface MockUser {
  email?: string;
}

interface Conversation {
  id: string;
  title: string;
  messages_count: number;
  credits_used: number;
  created_date: string;
}

// 使用历史卡片
export const UsageHistoryCard = memo(function UsageHistoryCard({ user }: { user: MockUser }) {
  // 使用空数组展示空状态（根据截图要求）
  const conversations: Conversation[] = [];

  // 如果需要模拟数据进行测试，可以取消下面的注释
  // const conversations: Conversation[] = [
  //   { id: '1', title: 'AI 智能对话 - 代码优化', messages_count: 12, credits_used: 45, created_date: new Date().toISOString() },
  //   { id: '2', title: '文案生成 - 产品介绍', messages_count: 8, credits_used: 28, created_date: new Date(Date.now() - 3600000).toISOString() },
  //   { id: '3', title: 'AI 助手 - 数据分析', messages_count: 15, credits_used: 52, created_date: new Date(Date.now() - 86400000).toISOString() },
  // ];

  if (conversations.length === 0) {
    return (
      <div
        className="rounded-2xl p-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <h3 className="text-lg font-bold mb-6" style={{ color: 'var(--text-primary)' }}>使用历史</h3>
        <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
          暂无使用记录
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>使用历史</h3>
        <Link href="/chat">
          <Button
            variant="outline"
            size="sm"
            style={{
              background: 'transparent',
              borderColor: 'rgba(255, 215, 0, 0.3)',
              color: 'var(--color-primary)'
            }}
          >
            查看全部对话
          </Button>
        </Link>
      </div>

      <div className="space-y-3">
        {conversations.map((conv) => {
          const convDate = new Date(conv.created_date);
          const dateStr = `${String(convDate.getMonth() + 1).padStart(2, '0')}-${String(convDate.getDate()).padStart(2, '0')} ${String(convDate.getHours()).padStart(2, '0')}:${String(convDate.getMinutes()).padStart(2, '0')}`;

          return (
            <div
              key={conv.id}
              className="flex items-center justify-between p-4 rounded-xl transition-all duration-200"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-primary)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 215, 0, 0.2)';
                e.currentTarget.style.transform = 'translateX(4px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-primary)';
                e.currentTarget.style.transform = 'translateX(0)';
              }}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div
                  className="p-2 rounded-lg"
                  style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
                >
                  <History className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{conv.title || '新对话'}</div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {conv.messages_count} 条消息 · 消耗 {conv.credits_used} 积分
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 ml-4">
                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {dateStr}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
