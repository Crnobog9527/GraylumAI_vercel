'use client';

import { ReactNode } from 'react';
import { Inbox, FileX, Users, MessageSquare, Package, Bell, Ticket, CreditCard } from 'lucide-react';
import { Button } from './button';
import { TableCell, TableRow } from './table';

// 预定义图标
const icons: Record<string, typeof Inbox> = {
  default: Inbox,
  file: FileX,
  users: Users,
  messages: MessageSquare,
  packages: Package,
  announcements: Bell,
  tickets: Ticket,
  transactions: CreditCard,
};

type IconType = keyof typeof icons;

interface EmptyStateProps {
  icon?: IconType | ReactNode;
  title?: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon = 'default',
  title = '暂无数据',
  description,
  action,
  className = '',
}: EmptyStateProps) {
  const IconComponent = typeof icon === 'string' ? icons[icon] : null;

  return (
    <div className={`flex flex-col items-center justify-center py-12 ${className}`}>
      <div
        className="p-4 rounded-full mb-4"
        style={{ background: 'var(--bg-tertiary)' }}
      >
        {typeof icon === 'string' && IconComponent ? (
          <IconComponent className="h-8 w-8" style={{ color: 'var(--text-disabled)' }} />
        ) : (
          icon
        )}
      </div>
      <p className="text-lg font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </p>
      {description && (
        <p className="text-sm mb-4" style={{ color: 'var(--text-disabled)' }}>
          {description}
        </p>
      )}
      {action && (
        <Button onClick={action.onClick} className="mt-2">
          {action.label}
        </Button>
      )}
    </div>
  );
}

// 表格专用空状态
interface TableEmptyStateProps {
  colSpan: number;
  message?: string;
  action?: string;
}

export function TableEmptyState({
  colSpan,
  message = '暂无数据',
  action,
}: TableEmptyStateProps) {
  return (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className="text-center py-12"
        style={{ color: 'var(--text-disabled)' }}
      >
        <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{message}</p>
        {action && (
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {action}
          </p>
        )}
      </TableCell>
    </TableRow>
  );
}
