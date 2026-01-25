'use client';

import { useRouter } from 'next/navigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, CreditCard, Sparkles } from 'lucide-react';
import { WarningLevel, getWarningColor } from '@/hooks/use-credits';

interface LowBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credits: number;
  warningLevel: WarningLevel;
}

export function LowBalanceDialog({
  open,
  onOpenChange,
  credits,
  warningLevel,
}: LowBalanceDialogProps) {
  const router = useRouter();
  const warningColor = getWarningColor(warningLevel);

  const handleRecharge = () => {
    onOpenChange(false);
    router.push('/profile?tab=subscription');
  };

  const getTitle = () => {
    if (warningLevel === 'empty') return '积分已用完';
    if (warningLevel === 'critical') return '积分即将用完';
    return '积分余额不足';
  };

  const getDescription = () => {
    if (warningLevel === 'empty') {
      return '您的积分已用完，无法发送消息。请充值积分后继续使用 AI 对话功能。';
    }
    if (warningLevel === 'critical') {
      return `您的积分仅剩 ${credits} 积分，可能无法完成下一次对话。建议立即充值以确保正常使用。`;
    }
    return `您的积分余额较低（${credits} 积分），建议及时充值以免影响使用。`;
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{
                background: `${warningColor}15`,
              }}
            >
              <AlertTriangle className="h-6 w-6" style={{ color: warningColor }} />
            </div>
            <AlertDialogTitle
              className="text-xl"
              style={{ color: 'var(--text-primary)' }}
            >
              {getTitle()}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription
            className="text-base leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {getDescription()}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* 积分显示 */}
        <div
          className="flex items-center justify-center gap-3 py-4 my-2 rounded-xl"
          style={{
            background: `${warningColor}10`,
            border: `1px solid ${warningColor}30`,
          }}
        >
          <Sparkles className="h-5 w-5" style={{ color: warningColor }} />
          <span className="text-2xl font-bold" style={{ color: warningColor }}>
            {credits}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>积分剩余</span>
        </div>

        <AlertDialogFooter className="gap-2 sm:gap-2">
          {warningLevel !== 'empty' && (
            <AlertDialogCancel
              style={{
                background: 'transparent',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-secondary)',
              }}
            >
              稍后再说
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            onClick={handleRecharge}
            className="gap-2"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              color: 'var(--bg-primary)',
              border: 'none',
            }}
          >
            <CreditCard className="h-4 w-4" />
            立即充值
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default LowBalanceDialog;
