'use client';

import { ReactNode } from 'react';
import {
  Check,
  X,
  Clock,
  AlertCircle,
  CheckCircle,
  XCircle,
  Hourglass,
  Ban,
  Sparkles,
} from 'lucide-react';
import { Badge } from './badge';

// 预定义状态配置
const statusConfigs = {
  // 通用状态
  active: { color: 'emerald', icon: Check, label: '启用' },
  inactive: { color: 'rose', icon: X, label: '禁用' },
  enabled: { color: 'emerald', icon: Check, label: '已启用' },
  disabled: { color: 'rose', icon: X, label: '已禁用' },

  // 工单状态
  pending: { color: 'amber', icon: Clock, label: '待处理' },
  processing: { color: 'blue', icon: Hourglass, label: '处理中' },
  resolved: { color: 'emerald', icon: CheckCircle, label: '已解决' },
  closed: { color: 'slate', icon: XCircle, label: '已关闭' },

  // 邀请码状态
  available: { color: 'emerald', icon: Sparkles, label: '可用' },
  used: { color: 'blue', icon: Check, label: '已使用' },
  expired: { color: 'rose', icon: Ban, label: '已过期' },

  // 交易状态
  completed: { color: 'emerald', icon: CheckCircle, label: '已完成' },
  failed: { color: 'rose', icon: XCircle, label: '失败' },
  refunded: { color: 'amber', icon: AlertCircle, label: '已退款' },

  // 优先级
  low: { color: 'slate', icon: null, label: '低' },
  medium: { color: 'amber', icon: null, label: '中' },
  high: { color: 'rose', icon: null, label: '高' },
  urgent: { color: 'red', icon: AlertCircle, label: '紧急' },

  // 公告类型
  info: { color: 'blue', icon: null, label: '通知' },
  warning: { color: 'amber', icon: AlertCircle, label: '警告' },
  success: { color: 'emerald', icon: CheckCircle, label: '成功' },
  error: { color: 'rose', icon: XCircle, label: '错误' },

  // 角色
  admin: { color: 'purple', icon: Sparkles, label: '管理员' },
  user: { color: 'blue', icon: null, label: '用户' },
  vip: { color: 'amber', icon: Sparkles, label: 'VIP' },
} as const;

type StatusType = keyof typeof statusConfigs;

// 颜色映射
const colorClasses = {
  emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  rose: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
  amber: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  slate: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  red: 'bg-red-500/20 text-red-400 border-red-500/30',
} as const;

type ColorType = keyof typeof colorClasses;

interface StatusBadgeProps {
  status: StatusType | string;
  label?: string;
  showIcon?: boolean;
  color?: ColorType;
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
}

export function StatusBadge({
  status,
  label,
  showIcon = true,
  color,
  icon,
  onClick,
  className = '',
}: StatusBadgeProps) {
  // 获取预定义配置或使用自定义
  const config = statusConfigs[status as StatusType];
  const displayLabel = label ?? config?.label ?? status;
  const displayColor = color ?? (config?.color as ColorType) ?? 'slate';
  const IconComponent = config?.icon;

  return (
    <Badge
      className={`
        ${colorClasses[displayColor]}
        ${onClick ? 'cursor-pointer hover:opacity-80' : ''}
        ${className}
      `}
      onClick={onClick}
    >
      {showIcon && icon}
      {showIcon && !icon && IconComponent && <IconComponent className="h-3 w-3 mr-1" />}
      {displayLabel}
    </Badge>
  );
}

// 便捷组件：活跃/禁用切换徽章
interface ToggleBadgeProps {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
  onClick?: () => void;
}

export function ToggleBadge({
  active,
  activeLabel = '已启用',
  inactiveLabel = '已禁用',
  onClick,
}: ToggleBadgeProps) {
  return (
    <StatusBadge
      status={active ? 'active' : 'inactive'}
      label={active ? activeLabel : inactiveLabel}
      onClick={onClick}
    />
  );
}

// 便捷组件：角色徽章
export function RoleBadge({ role }: { role: string }) {
  const roleConfig: Record<string, { color: ColorType; label: string }> = {
    admin: { color: 'purple', label: '管理员' },
    user: { color: 'blue', label: '用户' },
    vip: { color: 'amber', label: 'VIP' },
  };

  const config = roleConfig[role] ?? { color: 'slate', label: role };

  return (
    <StatusBadge
      status={role}
      label={config.label}
      color={config.color}
      showIcon={false}
    />
  );
}
