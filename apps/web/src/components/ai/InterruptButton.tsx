'use client';

/**
 * InterruptButton Component
 *
 * AI 响应中断按钮
 */

import React, { useState } from 'react';
import { StopCircle, Square, Loader2 } from 'lucide-react';

// ============================================
// 类型定义
// ============================================

interface InterruptButtonProps {
  onInterrupt: () => void;
  className?: string;
  variant?: 'default' | 'minimal' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

// ============================================
// 组件实现
// ============================================

export function InterruptButton({
  onInterrupt,
  className = '',
  variant = 'default',
  size = 'md',
  showLabel = true,
}: InterruptButtonProps) {
  const [isInterrupting, setIsInterrupting] = useState(false);

  const handleClick = async () => {
    setIsInterrupting(true);
    onInterrupt();

    // 短暂延迟后重置状态
    setTimeout(() => {
      setIsInterrupting(false);
    }, 500);
  };

  // 尺寸样式
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-3 text-base',
  };

  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  // 变体样式
  const variantClasses = {
    default:
      'bg-muted text-foreground hover:bg-muted/80 border border-border',
    minimal:
      'text-muted-foreground hover:text-foreground hover:bg-muted',
    danger:
      'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  };

  return (
    <button
      onClick={handleClick}
      disabled={isInterrupting}
      className={`
        inline-flex items-center justify-center gap-2
        rounded-md font-medium
        transition-all duration-200
        focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
        disabled:opacity-50 disabled:cursor-not-allowed
        ${sizeClasses[size]}
        ${variantClasses[variant]}
        ${className}
      `}
      aria-label="中断响应"
    >
      {isInterrupting ? (
        <Loader2 className={`${iconSizes[size]} animate-spin`} />
      ) : variant === 'danger' ? (
        <Square className={iconSizes[size]} />
      ) : (
        <StopCircle className={iconSizes[size]} />
      )}

      {showLabel && (
        <span>{isInterrupting ? '正在中断...' : '停止生成'}</span>
      )}
    </button>
  );
}

/**
 * 浮动中断按钮 (用于页面角落)
 */
export function FloatingInterruptButton({
  onInterrupt,
  isVisible = true,
  position = 'bottom-right',
}: {
  onInterrupt: () => void;
  isVisible?: boolean;
  position?: 'bottom-right' | 'bottom-center' | 'bottom-left';
}) {
  if (!isVisible) return null;

  const positionClasses = {
    'bottom-right': 'bottom-4 right-4',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2',
    'bottom-left': 'bottom-4 left-4',
  };

  return (
    <div
      className={`
        fixed z-50 animate-in fade-in slide-in-from-bottom-4 duration-300
        ${positionClasses[position]}
      `}
    >
      <InterruptButton
        onInterrupt={onInterrupt}
        variant="danger"
        size="lg"
        className="shadow-lg"
      />
    </div>
  );
}

export default InterruptButton;
